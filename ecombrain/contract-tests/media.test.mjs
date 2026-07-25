// Contract test — media protocol (Blossom BUD-02/11) against the local Buzz
// relay at http://localhost:3335.
//
// This test defines the WIRE FORMAT the PlatformMedia adapter must use; it
// talks to the relay directly (no adapter import):
//   PUT /media/upload — Blossom kind:24242 auth event (tags t=upload,
//     x=sha256hex, expiration>now, server=tenant host; non-empty content),
//     X-SHA-256 header, raw octet-stream body → 200 + BlobDescriptor {url, sha256}.
//   GET {descriptor.url} — unauthenticated, byte-identical body.
//
// Auth-event shape mirrors ecombrain/spike/verify.mjs (blossomHeader), which
// was verified against buzz-media/src/auth.rs:15-124. Tenant host is
// localhost:3335 — the `server` tag is matched against the bound tenant host.
//
// Run: node --test media.test.mjs   (from ecombrain/contract-tests; relay up)

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";

const BASE_URL = "http://localhost:3335";
const TENANT_HOST = "localhost:3335";

const nowSecs = () => Math.floor(Date.now() / 1000);
const sha256hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// Throwaway key per run — upload auth is identity-scoped but the relay only
// checks the signature + tags.
const sk = generateSecretKey();

/** Blossom BUD-11 kind:24242 authorization header (spike verify.mjs:123). */
function blossomHeader(hashHex) {
  const tags = [
    ["t", "upload"],
    ["x", hashHex],
    ["expiration", String(nowSecs() + 300)],
    ["server", TENANT_HOST],
  ];
  const ev = finalizeEvent(
    { kind: 24242, created_at: nowSecs(), tags, content: "contract media upload" },
    sk,
  );
  return `Nostr ${b64(JSON.stringify(ev))}`;
}

async function upload(bytes) {
  const hash = sha256hex(bytes);
  const res = await fetch(`${BASE_URL}/media/upload`, {
    method: "PUT",
    headers: {
      Authorization: blossomHeader(hash),
      "X-SHA-256": hash,
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, hash };
}

test("protocol: 1MB upload returns 200 + BlobDescriptor {url, sha256}", async () => {
  const bytes = randomBytes(1024 * 1024);
  const { status, json, hash } = await upload(bytes);

  assert.equal(status, 200, `upload status (body: ${JSON.stringify(json)})`);
  assert.equal(json.sha256, hash, "descriptor sha256 matches the body hash");
  assert.equal(typeof json.url, "string");
  assert.ok(json.url.includes(`/media/${hash}`), "url carries the blob path");
});

test("protocol: GET descriptor url returns byte-identical content", async () => {
  const bytes = randomBytes(64 * 1024);
  const { status, json } = await upload(bytes);
  assert.equal(status, 200);

  const url = new URL(json.url, BASE_URL);
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = new Uint8Array(await res.arrayBuffer());
  assert.equal(sha256hex(body), sha256hex(bytes), "downloaded bytes identical");
});

test("protocol: 20MB upload succeeds", async () => {
  const bytes = randomBytes(20 * 1024 * 1024);
  const { status, json, hash } = await upload(bytes);
  assert.equal(status, 200, `upload status (body: ${JSON.stringify(json)})`);
  assert.equal(json.sha256, hash);
});
