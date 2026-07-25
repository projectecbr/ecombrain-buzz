import assert from "node:assert/strict";
import test from "node:test";

globalThis.window = { location: { origin: "https://app.ecombrain.ai" } };

const { buildMessageLink, parseMessageLink } = await import(
  "./messageLink.web.ts"
);

test("builds and parses same-origin Teams message links", () => {
  const url = buildMessageLink({
    channelId: "room/one",
    messageId: "message-1",
    threadRootId: "thread-1",
  });

  assert.equal(
    url,
    "https://app.ecombrain.ai/teams/#/channels/room%2Fone?messageId=message-1&threadRootId=thread-1",
  );
  assert.deepEqual(parseMessageLink(url), {
    ok: true,
    value: {
      channelId: "room/one",
      messageId: "message-1",
      threadRootId: "thread-1",
    },
  });
});

test("rejects cross-origin message links", () => {
  assert.deepEqual(
    parseMessageLink(
      "https://attacker.example/teams/#/channels/room?messageId=message-1",
    ),
    { ok: false, reason: "wrong-origin" },
  );
});
