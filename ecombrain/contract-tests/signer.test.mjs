// Contract test — Adapter B (platform signer, localkey dev implementation).
//
// Imports the real desktop platform adapter
// (desktop/src/platform/signer.localkey.ts) and drives it through the
// PlatformSigner interface:
//   1. sign a kind 1 event → verify locally with nostr-tools verifyEvent
//      (incl. created_at override + deterministic getPublicKey);
//   2. sign a NIP-42 kind:22242 auth event → the local staging-backed Buzz
//      relay at ws://localhost:3335 must accept it (["OK", id, true]).
//
// This is the DEV-ONLY browser signer (module memory + sessionStorage);
// Phase 4 replaces it with the NIP-46 bunker signer.
//
// Run: npm test   (from ecombrain/contract-tests; relay must be up —
// `docker start buzz-relay-staging`, ~20s boot)

import assert from "node:assert/strict";
import test from "node:test";
import { verifyEvent } from "nostr-tools";
import { WebSocket } from "ws";

import { createLocalKeySigner } from "../../desktop/src/platform/signer.localkey.ts";

const RELAY_URL = "ws://localhost:3335";
// NIP-42 relay tag must carry the TENANT host; the local relay is seeded
// with tenant host localhost:3335.
const RELAY_TAG = "ws://localhost:3335";

test("localkey signer: kind 1 event verifies with nostr-tools", async () => {
  const signer = createLocalKeySigner();

  const pubkey = await signer.getPublicKey();
  assert.match(pubkey, /^[0-9a-f]{64}$/, "getPublicKey returns a hex pubkey");
  assert.equal(
    await signer.getPublicKey(),
    pubkey,
    "getPublicKey is deterministic for the session",
  );

  const createdAt = Math.floor(Date.now() / 1000) - 60;
  const event = await signer.signEvent({
    kind: 1,
    content: "signer contract test",
    tags: [["t", "contract"]],
    created_at: createdAt,
  });

  assert.equal(event.kind, 1);
  assert.equal(event.content, "signer contract test");
  assert.deepEqual(event.tags, [["t", "contract"]]);
  assert.equal(event.created_at, createdAt, "created_at override honored");
  assert.equal(event.pubkey, pubkey, "event signed by the signer pubkey");
  assert.ok(verifyEvent(event), "event id + signature verify");
});

test("localkey signer: NIP-42 kind:22242 accepted by ws://localhost:3335", async () => {
  const signer = createLocalKeySigner();

  const ws = new WebSocket(RELAY_URL);
  try {
    const challenge = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for AUTH challenge")),
        5000,
      );
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg[0] === "AUTH") {
          clearTimeout(timer);
          resolve(msg[1]);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const authEvent = await signer.signEvent({
      kind: 22242,
      content: "",
      tags: [
        ["relay", RELAY_TAG],
        ["challenge", challenge],
      ],
    });
    ws.send(JSON.stringify(["AUTH", authEvent]));

    const ok = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for AUTH OK")),
        5000,
      );
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg[0] === "OK" && msg[1] === authEvent.id) {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.equal(
      ok[2],
      true,
      `relay rejected NIP-42 auth: ${ok[3] ?? "no message"}`,
    );
  } finally {
    ws.close();
  }
});
