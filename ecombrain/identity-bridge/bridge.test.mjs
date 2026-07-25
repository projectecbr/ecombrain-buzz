import assert from "node:assert/strict";
import test from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
} from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";

import { createRpcHandler } from "./bridge.mjs";

function requestEvent(clientSecret, bunkerPubkey, request, createdAt = 1_700_000_000) {
  const conversationKey = nip44.v2.utils.getConversationKey(
    clientSecret,
    bunkerPubkey,
  );
  return finalizeEvent(
    {
      kind: 24133,
      tags: [["p", bunkerPubkey]],
      content: nip44.v2.encrypt(JSON.stringify(request), conversationKey),
      created_at: createdAt,
    },
    clientSecret,
  );
}

function responsePayload(clientSecret, response) {
  const conversationKey = nip44.v2.utils.getConversationKey(
    clientSecret,
    response.pubkey,
  );
  return JSON.parse(nip44.v2.decrypt(response.content, conversationKey));
}

test("connect validates the server grant before signing for that client", async () => {
  const bunkerSecret = generateSecretKey();
  const bunkerPubkey = getPublicKey(bunkerSecret);
  const clientSecret = generateSecretKey();
  const calls = [];
  const handle = createRpcHandler({
    bunkerSecret,
    now: () => 1_700_000_000_000,
    callProduct: async (input) => {
      calls.push(input);
      if (input.method === "connect") return { result: "ack" };
      if (input.method === "get_public_key") return { result: "b".repeat(64) };
      return { result: JSON.stringify({ id: "signed" }) };
    },
  });

  const connect = await handle(
    requestEvent(clientSecret, bunkerPubkey, {
      id: "1",
      method: "connect",
      params: [bunkerPubkey, "s".repeat(43)],
    }),
  );
  assert.ok(connect && verifyEvent(connect));
  assert.deepEqual(responsePayload(clientSecret, connect), { id: "1", result: "ack" });

  const getKey = await handle(
    requestEvent(clientSecret, bunkerPubkey, {
      id: "2",
      method: "get_public_key",
      params: [],
    }),
  );
  assert.deepEqual(responsePayload(clientSecret, getKey), {
    id: "2",
    result: "b".repeat(64),
  });
  assert.equal(calls[1].connectionSecret, "s".repeat(43));
  assert.equal(calls[1].clientPubkey, getPublicKey(clientSecret));
});

test("an unconnected client cannot ask the bridge to sign", async () => {
  const bunkerSecret = generateSecretKey();
  const bunkerPubkey = getPublicKey(bunkerSecret);
  const clientSecret = generateSecretKey();
  let called = false;
  const handle = createRpcHandler({
    bunkerSecret,
    now: () => 1_700_000_000_000,
    callProduct: async () => {
      called = true;
      return { result: "unexpected" };
    },
  });
  const response = await handle(
    requestEvent(clientSecret, bunkerPubkey, {
      id: "1",
      method: "sign_event",
      params: [JSON.stringify({ kind: 9, content: "hello", tags: [] })],
    }),
  );

  assert.match(responsePayload(clientSecret, response).error, /not connected/);
  assert.equal(called, false);
});
