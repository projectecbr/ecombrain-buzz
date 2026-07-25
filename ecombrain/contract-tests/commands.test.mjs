// Contract test — Adapter C (browser commands over NIP-98 REST).
//
// Imports the real desktop platform adapter
// (desktop/src/platform/commands.browser.ts) and drives it against the local
// staging-backed Buzz relay at http://localhost:3335, covering the CORE
// command domains from ecombrain/phase2/command-map.md:
//   channels (create/list/details), messages (send/history/event/thread),
//   feed + search (mention/query), dms (open/hide).
//
// The adapter is NIP-98-only: every request is signed via the platform
// signer (kind:27235, u/method/payload/nonce tags) even though the local
// relay has BUZZ_REQUIRE_AUTH_TOKEN=false — production turns auth on.
// The `u` tag must carry the full URL with the TENANT host
// (localhost:3335 is the seeded tenant host).
//
// Run: npm test   (from ecombrain/contract-tests; relay must be up —
// `docker start buzz-relay-staging`, ~20s boot)

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { generateSecretKey, getPublicKey } from "nostr-tools";

import { createBrowserCommands } from "../../desktop/src/platform/commands.browser.ts";
import { createLocalKeySigner } from "../../desktop/src/platform/signer.localkey.ts";

const BASE_URL = "http://localhost:3335";

const signer = createLocalKeySigner();
const commands = createBrowserCommands({ signer, baseUrl: BASE_URL, bindRoomFn: async () => {} });

const call = (command, args) => commands.call(command, args);
const nowSecs = () => Math.floor(Date.now() / 1000);

// Unique run marker so repeated test runs never collide on the shared relay.
const RUN = randomUUID().slice(0, 8);

// Shared state across the (serial) tests below.
let channelId;
let rootEventId;

test("channels: create_channel returns the Rust ChannelInfo shape", async () => {
  const channel = await call("create_channel", {
    name: `cmd-${RUN}`,
    channelType: "stream",
    visibility: "open",
    description: `contract test ${RUN}`,
  });

  assert.match(channel.id, /^[0-9a-f-]{36}$/, "id is a uuid");
  assert.equal(channel.name, `cmd-${RUN}`);
  assert.equal(channel.channel_type, "stream");
  assert.equal(channel.visibility, "open");
  assert.equal(channel.description, `contract test ${RUN}`);
  assert.equal(channel.topic, null);
  assert.equal(channel.purpose, null);
  assert.equal(channel.is_member, true);
  assert.equal(channel.archived_at, null);
  assert.ok(Array.isArray(channel.member_pubkeys));
  assert.ok(Array.isArray(channel.participants));
  assert.ok(Array.isArray(channel.participant_pubkeys));
  assert.equal(typeof channel.member_count, "number");
  assert.ok("last_message_at" in channel);
  assert.ok("ttl_seconds" in channel);
  assert.ok("ttl_deadline" in channel);

  channelId = channel.id;
});

test("channels: get_channels lists the created channel as a member channel", async () => {
  const channels = await call("get_channels");
  assert.ok(Array.isArray(channels));

  const mine = channels.find((c) => c.id === channelId);
  assert.ok(mine, "created channel is listed");
  assert.equal(mine.is_member, true);
  assert.equal(mine.name, `cmd-${RUN}`);
});

test("channels: get_channel_details returns ChannelDetailInfo", async () => {
  const detail = await call("get_channel_details", { channelId });

  assert.equal(detail.id, channelId);
  assert.equal(detail.name, `cmd-${RUN}`);
  // created_by is the kind:39000 event's pubkey. The relay synthesizes the
  // metadata event itself, so this is the relay's pubkey, not the creator's —
  // same as the Rust `channel_detail_from_event` (event.pubkey).
  assert.match(detail.created_by, /^[0-9a-f]{64}$/);
  assert.match(detail.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(detail.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(detail.topic_set_by, null);
  assert.equal(detail.topic_required, false);
  assert.ok("nip29_group_id" in detail);
});

test("messages: send_channel_message + history readers agree", async () => {
  const content = `hello ${RUN}`;
  const sent = await call("send_channel_message", {
    channelId,
    content,
    parentEventId: null,
    mediaTags: null,
    emojiTags: null,
    mentionTags: null,
    mentionPubkeys: null,
    kind: null,
  });

  assert.match(sent.event_id, /^[0-9a-f]{64}$/);
  assert.equal(sent.parent_event_id, null);
  assert.equal(sent.root_event_id, null);
  assert.equal(sent.depth, 0);
  assert.ok(sent.created_at > 0);
  rootEventId = sent.event_id;

  // Keyset pager: everything before "now + slack" includes the message.
  const page = await call("get_channel_messages_before", {
    channelId,
    before: nowSecs() + 60,
    beforeId: null,
    limit: null,
  });
  assert.ok(
    page.events.some((ev) => ev.id === sent.event_id),
    "get_channel_messages_before returns the sent event",
  );
  assert.equal(page.next_cursor, null, "short page → no next cursor");

  // Server-assembled window (message-list cold load).
  const window = await call("get_channel_window", {
    channelId,
    limitRows: 50,
    cursor: null,
  });
  assert.ok(
    window.some((ev) => ev.id === sent.event_id),
    "get_channel_window returns the sent event",
  );

  // get_event returns a JSON *string* (the wrapper JSON.parses it).
  const eventJson = await call("get_event", { eventId: sent.event_id });
  assert.equal(typeof eventJson, "string");
  const event = JSON.parse(eventJson);
  assert.equal(event.id, sent.event_id);
  assert.equal(event.content, content);
  assert.equal(event.kind, 9);
});

test("messages: thread reply resolves root + get_thread_replies", async () => {
  const reply = await call("send_channel_message", {
    channelId,
    content: `reply ${RUN}`,
    parentEventId: rootEventId,
    mediaTags: null,
    emojiTags: null,
    mentionTags: null,
    mentionPubkeys: null,
    kind: null,
  });

  assert.equal(reply.parent_event_id, rootEventId);
  assert.equal(reply.root_event_id, rootEventId, "reply to root → root is parent");
  assert.equal(reply.depth, 1);

  const thread = await call("get_thread_replies", {
    rootEventId,
    channelId,
    limit: null,
    depthLimit: null,
    cursor: null,
  });
  assert.ok(
    thread.events.some((ev) => ev.id === reply.event_id),
    "thread subtree includes the reply",
  );
  assert.ok(
    thread.events.every((ev) => ev.id !== rootEventId),
    "root itself is not part of the reply set",
  );
});

test("feed/search: mention lands in get_feed, content in search_messages", async () => {
  const myPubkey = await signer.getPublicKey();
  const mention = await call("send_channel_message", {
    channelId,
    content: `mentionprobe ${RUN}`,
    parentEventId: null,
    mediaTags: null,
    emojiTags: null,
    mentionTags: null,
    mentionPubkeys: [myPubkey],
    kind: null,
  });

  const feed = await call("get_feed", {});
  assert.ok(
    feed.feed.mentions.some((item) => item.id === mention.event_id),
    "mention appears in the mentions section",
  );
  assert.equal(feed.feed.activity.length, 0);
  assert.equal(feed.feed.agent_activity.length, 0);
  assert.equal(typeof feed.meta.total, "number");
  assert.ok(feed.meta.generated_at > 0);

  const search = await call("search_messages", {
    q: `mentionprobe ${RUN}`,
    limit: 10,
    channelId,
  });
  assert.ok(
    search.hits.some((hit) => hit.event_id === mention.event_id),
    "search finds the message",
  );
  const hit = search.hits.find((h) => h.event_id === mention.event_id);
  assert.equal(hit.channel_id, channelId);
  assert.equal(hit.pubkey, myPubkey);
  assert.ok(hit.score > 0 && hit.score <= 1);
});

test("dms: open_dm returns a dm channel, hide_dm removes it from get_channels", async () => {
  const otherPubkey = getPublicKey(generateSecretKey());

  const dm = await call("open_dm", { pubkeys: [otherPubkey] });
  assert.equal(dm.channel_type, "dm");
  assert.equal(dm.visibility, "private");
  assert.ok(dm.id, "dm channel id from the relay ack");
  assert.equal(dm.is_member, true);

  const before = await call("get_channels");
  assert.ok(
    before.some((c) => c.id === dm.id),
    "open dm is listed",
  );

  await call("hide_dm", { channelId: dm.id });

  const after = await call("get_channels");
  assert.ok(
    !after.some((c) => c.id === dm.id),
    "hidden dm is no longer listed",
  );
});

test("unported commands fail loudly with not-ported-yet", async () => {
  await assert.rejects(
    call("list_personas"),
    /not-ported-yet: list_personas/,
  );
});
