import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserCommands } from "./commands.browser.ts";
import { defaultRelayWsUrl } from "./commands/context.ts";

test("same-origin relay stays under the authenticated Teams path", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { protocol: "https:", host: "app.ecombrain.io" } },
  });

  try {
    assert.equal(defaultRelayWsUrl(), "wss://app.ecombrain.io/teams/relay");
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete globalThis.window;
    }
  }
});

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
