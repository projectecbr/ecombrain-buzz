import { pathToFileURL } from "node:url";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import { hexToBytes } from "nostr-tools/utils";
import { WebSocketServer } from "ws";

import { createProvisioner } from "./provisioning.mjs";

const NOSTR_CONNECT_KIND = 24133;
const HEX_KEY = /^[0-9a-f]{64}$/;
const CONNECTION_SECRET = /^[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BYTES = 128 * 1024;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 30;
const MAX_FRAME_BYTES = 160 * 1024;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function matchesResponse(filter, event) {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (
    Array.isArray(filter.authors) &&
    !filter.authors.includes(event.pubkey)
  ) {
    return false;
  }
  if (Array.isArray(filter["#p"])) {
    const recipients = new Set(
      event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]),
    );
    if (!filter["#p"].some((pubkey) => recipients.has(pubkey))) return false;
  }
  return true;
}

function send(socket, frame) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

export async function createBunkerRelayServer({
  bunkerPubkey,
  handle,
  controlSecret,
  handleProvision,
  host,
  port,
}) {
  if (!HEX_KEY.test(bunkerPubkey) || typeof handle !== "function") {
    throw new Error("invalid bunker relay configuration");
  }
  const controlReplay = new Map();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/_health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.method === "POST" && request.url === "/provision" && handleProvision) {
      let rawBody = "";
      for await (const chunk of request) {
        rawBody += chunk;
        if (Buffer.byteLength(rawBody) > MAX_REQUEST_BYTES) {
          response.writeHead(413).end();
          return;
        }
      }
      const audience = request.headers["x-teams-service-audience"] ?? "";
      const issuedAt = Number(request.headers["x-teams-service-issued-at"]);
      const expiresAt = Number(request.headers["x-teams-service-expires-at"]);
      const requestId = request.headers["x-teams-service-request-id"] ?? "";
      const bodyHash = request.headers["x-teams-service-body-sha256"] ?? "";
      const authorization = request.headers.authorization ?? "";
      const now = Math.floor(Date.now() / 1000);
      for (const [id, expiry] of controlReplay) {
        if (expiry <= now) controlReplay.delete(id);
      }
      const expectedAudience = `teams-identity-provision:${bunkerPubkey}`;
      const signature = authorization.startsWith("Teams-HMAC ") ? authorization.slice(11) : "";
      const canonical = ["POST", "/teams/service/identity/provision", audience, issuedAt, expiresAt, requestId, bodyHash].join("\n");
      const expected = typeof controlSecret === "string" && controlSecret.length >= 32
        ? createHmac("sha256", controlSecret).update(canonical).digest("hex")
        : "";
      const valid = audience === expectedAudience && REQUEST_ID.test(requestId) &&
        /^[0-9a-f]{64}$/.test(bodyHash) && bodyHash === createHash("sha256").update(rawBody).digest("hex") &&
        Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt) && issuedAt <= now + 15 &&
        expiresAt >= now - 15 && expiresAt > issuedAt && expiresAt - issuedAt <= 60 &&
        /^[0-9a-f]{64}$/.test(signature) && /^[0-9a-f]{64}$/.test(expected) &&
        timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex")) &&
        (controlReplay.get(requestId) ?? 0) <= now;
      if (!valid) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end('{"error":"Unauthorized"}');
        return;
      }
      controlReplay.set(requestId, expiresAt + 15);
      try {
        const result = await handleProvision(JSON.parse(rawBody));
        response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "private, no-store" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end('{"error":"Provisioning request failed"}');
      }
      return;
    }
    response.writeHead(404).end();
  });
  const sockets = new Set();
  const websocket = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/") {
      socket.destroy();
      return;
    }
    websocket.handleUpgrade(request, socket, head, (client) => {
      websocket.emit("connection", client, request);
    });
  });
  websocket.on("connection", (socket) => {
    sockets.add(socket);
    const subscriptions = new Map();
    socket.on("close", () => sockets.delete(socket));
    socket.on("message", (raw, isBinary) => {
      if (isBinary || raw.byteLength > MAX_FRAME_BYTES) {
        socket.close(1003, "text frames only");
        return;
      }
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        send(socket, ["NOTICE", "invalid JSON"]);
        return;
      }
      if (!Array.isArray(frame) || typeof frame[0] !== "string") return;
      if (frame[0] === "REQ" && typeof frame[1] === "string") {
        const filters = frame.slice(2).filter(
          (filter) => filter && typeof filter === "object" && !Array.isArray(filter),
        );
        subscriptions.set(frame[1], filters);
        send(socket, ["EOSE", frame[1]]);
        return;
      }
      if (frame[0] === "CLOSE" && typeof frame[1] === "string") {
        subscriptions.delete(frame[1]);
        return;
      }
      if (frame[0] !== "EVENT" || !frame[1] || typeof frame[1] !== "object") {
        return;
      }
      const event = frame[1];
      void handle(event)
        .then((response) => {
          if (!response) {
            send(socket, ["OK", event.id ?? "", false, "rejected"]);
            return;
          }
          send(socket, ["OK", event.id, true, ""]);
          for (const [subscriptionId, filters] of subscriptions) {
            if (filters.some((filter) => matchesResponse(filter, response))) {
              send(socket, ["EVENT", subscriptionId, response]);
            }
          }
        })
        .catch(() => send(socket, ["OK", event.id ?? "", false, "rejected"]));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("bunker relay did not bind");
  return {
    url: `ws://${host}:${address.port}`,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.terminate();
        websocket.close();
        server.close(resolve);
      }),
  };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export async function startBridge() {
  const productApiUrl = new URL(
    "/api/internal/teams/identity/rpc",
    requiredEnv("TEAMS_PRODUCT_API_URL"),
  ).toString();
  const serviceSecret = requiredEnv("TEAMS_IDENTITY_BRIDGE_SECRET");
  const controlSecret = requiredEnv("TEAMS_PROVISIONING_CONTROL_SECRET");
  const secretHex = requiredEnv("TEAMS_BUNKER_SECRET_KEY");
  const operatorSecretHex = requiredEnv("TEAMS_OPERATOR_SECRET_KEY");
  if (
    !HEX_KEY.test(secretHex) ||
    !HEX_KEY.test(operatorSecretHex) ||
    serviceSecret.length < 32 ||
    controlSecret.length < 32
  ) {
    throw new Error("identity bridge secret configuration is invalid");
  }
  const bunkerSecret = hexToBytes(secretHex);
  const operatorSecret = hexToBytes(operatorSecretHex);
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
  const provisioner = createProvisioner({
    fetcher: fetch,
    publicBase: requiredEnv("TEAMS_PRODUCT_API_URL"),
    operatorOrigin: requiredEnv("TEAMS_OPERATOR_API_ORIGIN"),
    operatorSecret,
    operatorServiceSecret: requiredEnv("TEAMS_OPERATOR_SERVICE_SECRET"),
    bunkerPubkey,
    relayServiceMasterSecret: requiredEnv("TEAMS_RELAY_SERVICE_SECRET"),
  });
  const handleProvision = async (body) => {
    if (body?.action === "ensure") return provisioner.ensureCommunity(body);
    if (body?.action === "reconcile") return provisioner.reconcileCommunity(body);
    throw new Error("unsupported provisioning action");
  };
  const bind = requiredEnv("TEAMS_BUNKER_BIND_ADDR");
  const separator = bind.lastIndexOf(":");
  const host = bind.slice(0, separator);
  const port = Number(bind.slice(separator + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TEAMS_BUNKER_BIND_ADDR is invalid");
  }
  const relay = await createBunkerRelayServer({
    bunkerPubkey,
    handle,
    controlSecret,
    handleProvision,
    host,
    port,
  });
  const stop = () => {
    void relay.close();
    bunkerSecret.fill(0);
    operatorSecret.fill(0);
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
