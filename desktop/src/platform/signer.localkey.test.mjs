import assert from "node:assert/strict";
import test from "node:test";

import { verifyEvent } from "nostr-tools";

import {
  __resetLocalKeyForTests,
  createLocalKeySigner,
  LOCALKEY_STORAGE_KEY,
} from "./signer.localkey.ts";

test("localkeySigner_getPublicKeyIsDeterministicAcrossInstances", async () => {
  __resetLocalKeyForTests();
  const a = createLocalKeySigner();
  const b = createLocalKeySigner();
  const pubkey = await a.getPublicKey();
  assert.match(pubkey, /^[0-9a-f]{64}$/);
  assert.equal(await a.getPublicKey(), pubkey);
  assert.equal(await b.getPublicKey(), pubkey);
});

test("localkeySigner_signsVerifiableEventWithCreatedAtOverride", async () => {
  __resetLocalKeyForTests();
  const signer = createLocalKeySigner();
  const createdAt = Math.floor(Date.now() / 1000) - 120;

  const event = await signer.signEvent({
    kind: 1,
    content: "unit test",
    tags: [["t", "unit"]],
    created_at: createdAt,
  });

  assert.equal(event.created_at, createdAt);
  assert.equal(event.pubkey, await signer.getPublicKey());
  assert.equal(event.kind, 1);
  assert.equal(event.content, "unit test");
  assert.deepEqual(event.tags, [["t", "unit"]]);
  assert.ok(verifyEvent(event), "id + signature verify");
});

test("localkeySigner_defaultsCreatedAtToNow", async () => {
  __resetLocalKeyForTests();
  const signer = createLocalKeySigner();
  const before = Math.floor(Date.now() / 1000);
  const event = await signer.signEvent({ kind: 1, content: "", tags: [] });
  const after = Math.floor(Date.now() / 1000);
  assert.ok(event.created_at >= before && event.created_at <= after);
});

test("localkeySigner_persistsKeyToSessionStorageWhenAvailable", async () => {
  __resetLocalKeyForTests();
  const backing = new Map();
  globalThis.sessionStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => void backing.set(k, String(v)),
    removeItem: (k) => void backing.delete(k),
    clear: () => backing.clear(),
    key: () => null,
    get length() {
      return backing.size;
    },
  };
  try {
    const signer = createLocalKeySigner();
    const pubkey = await signer.getPublicKey();
    const stored = backing.get(LOCALKEY_STORAGE_KEY);
    assert.match(stored, /^[0-9a-f]{64}$/, "hex secret key persisted");

    // A fresh module-memory cache must recover the same identity from
    // sessionStorage instead of generating a new one.
    __resetLocalKeyForTests();
    assert.equal(await createLocalKeySigner().getPublicKey(), pubkey);
  } finally {
    delete globalThis.sessionStorage;
    __resetLocalKeyForTests();
  }
});

test("localkeySigner_exportsTheDevOnlyStorageKey", () => {
  // Guard against accidental renames onto the buzz-* prefix (reserved for
  // the desktop app) — the web dev identity key is ecombrain-teams-*.
  assert.equal(LOCALKEY_STORAGE_KEY, "ecombrain-teams-dev-identity");
  assert.ok(!LOCALKEY_STORAGE_KEY.startsWith("buzz-"));
});
