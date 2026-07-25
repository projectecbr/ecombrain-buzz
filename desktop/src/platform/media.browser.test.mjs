import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserMedia } from "./media.browser.ts";

test("browser media signs and uploads the exact Blossom body hash", async () => {
  let signed;
  let request;
  const bytes = new TextEncoder().encode("media contract");
  const media = createBrowserMedia({
    baseUrl: "https://teams.example.com",
    signer: {
      getPublicKey: async () => "0".repeat(64),
      signEvent: async (input) => {
        signed = input;
        return { ...input, id: "1", pubkey: "2", sig: "3", created_at: 1 };
      },
    },
    fetchFn: async (url, init) => {
      request = { url: String(url), init };
      const hash = init.headers["X-SHA-256"];
      return new Response(
        JSON.stringify({
          url: `https://teams.example.com/media/${hash}.bin`,
          sha256: hash,
          size: bytes.length,
          type: "application/octet-stream",
          uploaded: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  });

  const result = await media.uploadBytes(bytes, "safe.bin");
  assert.equal(signed.kind, 24242);
  assert.deepEqual(signed.tags[0], ["t", "upload"]);
  assert.deepEqual(signed.tags[3], ["server", "teams.example.com"]);
  assert.equal(request.url, "https://teams.example.com/media/upload");
  assert.equal(request.init.credentials, "include");
  assert.equal(result.filename, "safe.bin");
  assert.equal(result.sha256, signed.tags[1][1]);
});

test("browser media rejects non-MP4 video before signing", async () => {
  let signed = false;
  const media = createBrowserMedia({
    baseUrl: "https://teams.example.com",
    signer: {
      getPublicKey: async () => "0".repeat(64),
      signEvent: async () => {
        signed = true;
        throw new Error("must not sign");
      },
    },
  });

  await assert.rejects(
    media.uploadBytes(new Uint8Array([1]), "clip.mov"),
    /must be MP4/,
  );
  assert.equal(signed, false);
});
