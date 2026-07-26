import assert from "node:assert/strict";
import test from "node:test";

import {
  __resetBunkerSignerForTests,
  BUNKER_SESSION_KEY,
  createBunkerSigner,
} from "./signer.bunker.ts";

function memoryStorage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("bunker signer binds one ephemeral client and delegates signing", async () => {
  __resetBunkerSignerForTests();
  const storage = memoryStorage();
  let requestBody;
  const signed = {
    id: "c".repeat(64),
    pubkey: "b".repeat(64),
    created_at: 1,
    kind: 9,
    tags: [],
    content: "hello",
    sig: "d".repeat(128),
  };
  const nip44Calls = [];
  const signer = createBunkerSigner({
    storage,
    fetchFn: async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          identityPubkey: "b".repeat(64),
          expiresAt: Date.now() + 60_000,
          bunker: {
            pubkey: "e".repeat(64),
            relays: ["wss://app.ecombrain.io/teams/relay"],
            secret: "s".repeat(43),
          },
        }),
      );
    },
    createClient: (secret, pointer) => ({
      connect: async () => {
        assert.equal(secret.length, 32);
        assert.equal(pointer.secret, "s".repeat(43));
      },
      getPublicKey: async () => "b".repeat(64),
      signEvent: async () => signed,
      nip44Encrypt: async (pubkey, plaintext) => {
        nip44Calls.push(["encrypt", pubkey, plaintext]);
        return "ciphertext";
      },
      nip44Decrypt: async (pubkey, ciphertext) => {
        nip44Calls.push(["decrypt", pubkey, ciphertext]);
        return "plaintext";
      },
    }),
  });

  assert.equal(await signer.getPublicKey(), "b".repeat(64));
  assert.match(requestBody.clientPubkey, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    await signer.signEvent({ kind: 9, content: "hello", tags: [] }),
    signed,
  );
  assert.equal(await signer.encryptToSelf("plaintext"), "ciphertext");
  assert.equal(await signer.decryptFromSelf("ciphertext"), "plaintext");
  assert.deepEqual(nip44Calls, [
    ["encrypt", "b".repeat(64), "plaintext"],
    ["decrypt", "b".repeat(64), "ciphertext"],
  ]);
  assert.ok(storage.values.has(BUNKER_SESSION_KEY));
  assert.ok(
    !storage.values.get(BUNKER_SESSION_KEY).includes("b".repeat(64 * 2)),
  );
});

test("bunker signer rejects an identity mismatch and clears the session", async () => {
  __resetBunkerSignerForTests();
  const storage = memoryStorage();
  const signer = createBunkerSigner({
    storage,
    fetchFn: async () =>
      new Response(
        JSON.stringify({
          identityPubkey: "b".repeat(64),
          expiresAt: Date.now() + 60_000,
          bunker: {
            pubkey: "e".repeat(64),
            relays: ["wss://app.ecombrain.io/teams/relay"],
            secret: "s".repeat(43),
          },
        }),
      ),
    createClient: () => ({
      connect: async () => undefined,
      getPublicKey: async () => "f".repeat(64),
      signEvent: async () => {
        throw new Error("must not sign");
      },
    }),
  });

  await assert.rejects(signer.getPublicKey(), /does not match/);
  assert.equal(storage.values.has(BUNKER_SESSION_KEY), false);
});
