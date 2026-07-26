import assert from "node:assert/strict";
import test from "node:test";

import {
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import { BunkerSigner } from "nostr-tools/nip46";
import { useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";

import {
  createBunkerRelayServer,
  createRpcHandler,
  serviceHeaders,
} from "./bridge.mjs";

test("direct bunker websocket carries NIP-46 without relay membership", async () => {
  useWebSocketImplementation(WebSocket);
  const bunkerSecret = generateSecretKey();
  const clientSecret = generateSecretKey();
  const identitySecret = generateSecretKey();
  const identityPubkey = getPublicKey(identitySecret);
  const handler = createRpcHandler({
    bunkerSecret,
    callProduct: async ({ method }) => {
      if (method === "connect") return { result: "ack" };
      if (method === "get_public_key") return { result: identityPubkey };
      throw new Error("unexpected method");
    },
  });
  const relay = await createBunkerRelayServer({
    bunkerPubkey: getPublicKey(bunkerSecret),
    handle: handler,
    host: "127.0.0.1",
    port: 0,
  });

  const signer = BunkerSigner.fromBunker(clientSecret, {
    pubkey: getPublicKey(bunkerSecret),
    relays: [relay.url],
    secret: "s".repeat(43),
  });
  try {
    await signer.connect({ name: "EcomBrain Teams" });
    assert.equal(await signer.getPublicKey(), identityPubkey);
  } finally {
    await signer.close();
    await relay.close();
    bunkerSecret.fill(0);
    clientSecret.fill(0);
    identitySecret.fill(0);
  }
});

test("the provisioning control endpoint rejects replay and dispatches once", async () => {
  const bunkerSecret = generateSecretKey();
  const bunkerPubkey = getPublicKey(bunkerSecret);
  const controlSecret = "c".repeat(32);
  let calls = 0;
  const relay = await createBunkerRelayServer({
    bunkerPubkey,
    handle: async () => null,
    controlSecret,
    handleProvision: async (body) => {
      calls += 1;
      return { action: body.action, ok: true };
    },
    host: "127.0.0.1",
    port: 0,
  });
  const url = new URL("/provision", relay.url.replace("ws:", "http:"));
  const body = JSON.stringify({ action: "ensure" });
  const headers = serviceHeaders({
    secret: controlSecret,
    audience: `teams-identity-provision:${bunkerPubkey}`,
    method: "POST",
    url: "https://app.ecombrain.io/teams/service/identity/provision",
    body,
  });
  try {
    const first = await fetch(url, { method: "POST", headers, body });
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { action: "ensure", ok: true });
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 401);
    assert.equal(calls, 1);
  } finally {
    await relay.close();
    bunkerSecret.fill(0);
  }
});
