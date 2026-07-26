import { pathToFileURL } from "node:url";
import { createHash, createHmac, randomUUID } from "node:crypto";

import {
  finalizeEvent,
  getPublicKey,
  SimplePool,
  verifyEvent,
} from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { hexToBytes } from "nostr-tools/utils";
import WebSocket from "ws";

const NOSTR_CONNECT_KIND = 24133;
const HEX_KEY = /^[0-9a-f]{64}$/;
const CONNECTION_SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 128 * 1024;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 30;

export function serviceHeaders({
  secret,
  audience,
  method,
  url,
  body,
  now = Date.now(),
  requestId = randomUUID(),
}) {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 30;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const path = new URL(url).pathname;
  const canonical = [
    method,
    path,
    audience,
    issuedAt,
    expiresAt,
    requestId,
    bodyHash,
  ].join("\n");
  return {
    Authorization: `Teams-HMAC ${createHmac("sha256", secret).update(canonical).digest("hex")}`,
    "Content-Type": "application/json",
    "X-Teams-Service-Audience": audience,
    "X-Teams-Service-Issued-At": String(issuedAt),
    "X-Teams-Service-Expires-At": String(expiresAt),
    "X-Teams-Service-Request-Id": requestId,
    "X-Teams-Service-Body-Sha256": bodyHash,
  };
}

function validRpc(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= 128 &&
    typeof value.method === "string" &&
    Array.isArray(value.params) &&
    value.params.every((part) => typeof part === "string")
  );
}

export function createRpcHandler({
  bunkerSecret,
  callProduct,
  now = () => Date.now(),
}) {
  const bunkerPubkey = getPublicKey(bunkerSecret);
  const connections = new Map();
  const rates = new Map();

  function rateAllowed(clientPubkey) {
    const current = now();
    const previous = rates.get(clientPubkey);
    if (!previous || current - previous.startedAt >= RATE_WINDOW_MS) {
      rates.set(clientPubkey, { startedAt: current, count: 1 });
      return true;
    }
    previous.count += 1;
    return previous.count <= RATE_LIMIT;
  }

  async function dispatch(clientPubkey, request) {
    if (request.method === "connect") {
      const [requestedBunker, connectionSecret] = request.params;
      if (
        requestedBunker !== bunkerPubkey ||
        !connectionSecret ||
        !CONNECTION_SECRET.test(connectionSecret)
      ) {
        throw new Error("invalid connection grant");
      }
      const response = await callProduct({
        clientPubkey,
        connectionSecret,
        method: "connect",
      });
      connections.set(clientPubkey, connectionSecret);
      return response.result;
    }
    if (request.method === "logout") {
      connections.delete(clientPubkey);
      return "ack";
    }
    const connectionSecret = connections.get(clientPubkey);
    if (!connectionSecret) throw new Error("client is not connected");
    if (request.method === "ping") {
      await callProduct({ clientPubkey, connectionSecret, method: "connect" });
      return "pong";
    }
    if (request.method === "get_public_key") {
      return (
        await callProduct({
          clientPubkey,
          connectionSecret,
          method: "get_public_key",
        })
      ).result;
    }
    if (request.method === "sign_event") {
      const event = JSON.parse(request.params[0] ?? "null");
      return (
        await callProduct({
          clientPubkey,
          connectionSecret,
          method: "sign_event",
          event,
        })
      ).result;
    }
    if (
      request.method === "nip44_encrypt" ||
      request.method === "nip44_decrypt"
    ) {
      const [pubkey, value] = request.params;
      if (!HEX_KEY.test(pubkey ?? "") || typeof value !== "string") {
        throw new Error("invalid NIP-44 request");
      }
      return (
        await callProduct({
          clientPubkey,
          connectionSecret,
          method: request.method,
          pubkey,
          value,
        })
      ).result;
    }
    throw new Error("unsupported NIP-46 method");
  }

  return async function handle(event) {
    if (
      !verifyEvent(event) ||
      event.kind !== NOSTR_CONNECT_KIND ||
      !event.tags.some((tag) => tag[0] === "p" && tag[1] === bunkerPubkey) ||
      Math.abs(Math.floor(now() / 1000) - event.created_at) > 300 ||
      new TextEncoder().encode(event.content).byteLength > MAX_REQUEST_BYTES ||
      !rateAllowed(event.pubkey)
    ) {
      return null;
    }

    const conversationKey = nip44.v2.utils.getConversationKey(
      bunkerSecret,
      event.pubkey,
    );
    let request;
    try {
      request = JSON.parse(nip44.v2.decrypt(event.content, conversationKey));
    } catch {
      return null;
    }
    if (!validRpc(request)) return null;

    let payload;
    try {
      payload = {
        id: request.id,
        result: await dispatch(event.pubkey, request),
      };
    } catch (error) {
      payload = {
        id: request.id,
        error:
          error instanceof Error ? error.message : "identity request failed",
      };
    }
    return finalizeEvent(
      {
        kind: NOSTR_CONNECT_KIND,
        tags: [["p", event.pubkey]],
        content: nip44.v2.encrypt(JSON.stringify(payload), conversationKey),
        created_at: Math.floor(now() / 1000),
      },
      bunkerSecret,
    );
  };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function startBridge() {
  const relayUrl = requiredEnv("TEAMS_RELAY_URL");
  const productApiUrl = new URL(
    "/api/internal/teams/identity/rpc",
    requiredEnv("TEAMS_PRODUCT_API_URL"),
  ).toString();
  const serviceSecret = requiredEnv("TEAMS_IDENTITY_BRIDGE_SECRET");
  const secretHex = requiredEnv("TEAMS_BUNKER_SECRET_KEY");
  if (!HEX_KEY.test(secretHex) || serviceSecret.length < 32) {
    throw new Error("identity bridge secret configuration is invalid");
  }
  const bunkerSecret = hexToBytes(secretHex);
  const bunkerPubkey = getPublicKey(bunkerSecret);
  const callProduct = async (body) => {
    const rawBody = JSON.stringify(body);
    const response = await fetch(productApiUrl, {
      method: "POST",
      headers: serviceHeaders({
        secret: serviceSecret,
        audience: `teams-identity-bridge:${bunkerPubkey}`,
        method: "POST",
        url: productApiUrl,
        body: rawBody,
      }),
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(
        `product identity API rejected request (${response.status})`,
      );
    }
    return response.json();
  };
  const handle = createRpcHandler({ bunkerSecret, callProduct });

  useWebSocketImplementation(WebSocket);
  const pool = new SimplePool({ enableReconnect: true });
  const subscription = pool.subscribe(
    [relayUrl],
    {
      kinds: [NOSTR_CONNECT_KIND],
      "#p": [bunkerPubkey],
      since: Math.floor(Date.now() / 1000),
    },
    {
      onevent(event) {
        void handle(event)
          .then((response) =>
            response
              ? Promise.any(pool.publish([relayUrl], response))
              : undefined,
          )
          .catch(() => undefined);
      },
    },
  );
  const stop = () => {
    subscription.close();
    pool.destroy();
    bunkerSecret.fill(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startBridge().catch((error) => {
    console.error(
      "[teams-identity-bridge] startup failed:",
      error instanceof Error ? error.message : "unknown error",
    );
    process.exitCode = 1;
  });
}
