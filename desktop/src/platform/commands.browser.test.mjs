import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserCommands } from "./commands.browser.ts";

test("send_channel_message rejects caller-selected event kinds", async () => {
  let signed = false;
  const commands = createBrowserCommands({
    baseUrl: "https://relay.invalid",
    fetchFn: () => {
      throw new Error("fetch must not run");
    },
    signer: {
      getPublicKey: async () => "0".repeat(64),
      signEvent: async () => {
        signed = true;
        throw new Error("signer must not run");
      },
    },
  });

  await assert.rejects(
    commands.call("send_channel_message", {
      channelId: "00000000-0000-4000-8000-000000000000",
      content: "must not sign",
      parentEventId: null,
      mediaTags: null,
      emojiTags: null,
      mentionTags: null,
      mentionPubkeys: null,
      kind: 22242,
    }),
    /unsupported channel message kind: 22242/,
  );
  assert.equal(signed, false);
});
