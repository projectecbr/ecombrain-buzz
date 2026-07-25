// Feed, search, and canvas command handlers.

import type { RelayEvent } from "@/shared/api/types";

import {
  type Args,
  checkContent,
  firstTagValue,
  parseChannelUuid,
  type RelayContext,
} from "./context.ts";
import {
  KIND_APPROVAL_KINDS,
  KIND_CANVAS,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_TEXT_NOTE,
} from "./kinds.ts";

function feedItemFromEvent(event: RelayEvent, category: string) {
  return {
    id: event.id,
    kind: event.kind,
    pubkey: event.pubkey,
    content: event.content,
    created_at: event.created_at,
    channel_id: firstTagValue(event, "h") ?? null,
    channel_name: "",
    channel_type: null,
    tags: event.tags,
    category,
  };
}

function searchResponseFromEvents(events: RelayEvent[]) {
  const total = events.length;
  const hits = events.map((event, index) => ({
    event_id: event.id,
    content: event.content,
    kind: event.kind,
    pubkey: event.pubkey,
    channel_id: firstTagValue(event, "h") ?? null,
    channel_name: null,
    created_at: event.created_at,
    score: total <= 1 ? 1 : 1 - index / total,
  }));
  return { hits, found: hits.length };
}

export function socialHandlers(
  ctx: RelayContext,
): Record<string, (args: Args) => unknown | Promise<unknown>> {
  const { relayQuery, relayQueryOrEmpty, submitEvent, myPubkey } = ctx;

  async function getFeed(args: Args) {
    const since = (args.since as number | null | undefined) ?? null;
    const cap = Math.min((args.limit as number | null | undefined) ?? 50, 100);
    const requested = (args.types as string | null | undefined)
      ?.split(",")
      .map((value) => value.trim());
    const pubkey = await myPubkey();
    const mentionFilter: Record<string, unknown> = {
      kinds: [
        KIND_STREAM_MESSAGE,
        KIND_STREAM_MESSAGE_V2,
        KIND_TEXT_NOTE,
        KIND_FORUM_POST,
        KIND_FORUM_COMMENT,
      ],
      "#p": [pubkey],
      limit: cap,
    };
    const approvalFilter: Record<string, unknown> = {
      kinds: KIND_APPROVAL_KINDS,
      "#p": [pubkey],
      limit: 20,
    };
    if (since !== null) {
      mentionFilter.since = since;
      approvalFilter.since = since;
    }
    const mentionEvents =
      !requested || requested.includes("mentions")
        ? await relayQueryOrEmpty([mentionFilter])
        : [];
    const approvalEvents =
      !requested || requested.includes("needs_action")
        ? await relayQueryOrEmpty([approvalFilter])
        : [];
    const mentions = mentionEvents.map((event) =>
      feedItemFromEvent(event, "mentions"),
    );
    const needsAction = approvalEvents.map((event) =>
      feedItemFromEvent(event, "needs_action"),
    );
    return {
      feed: {
        mentions,
        needs_action: needsAction,
        activity: [],
        agent_activity: [],
      },
      meta: {
        since: since ?? 0,
        total: mentions.length + needsAction.length,
        generated_at: Math.floor(Date.now() / 1000),
      },
    };
  }

  async function searchMessages(args: Args) {
    const filter: Record<string, unknown> = {
      kinds: [
        KIND_STREAM_MESSAGE,
        KIND_STREAM_MESSAGE_V2,
        KIND_FORUM_POST,
        KIND_FORUM_COMMENT,
      ],
      search: (args.q as string).trim(),
      search_mode: "prefix",
      limit: Math.min((args.limit as number | null | undefined) ?? 20, 100),
    };
    const channelId = (args.channelId as string | null | undefined) ?? null;
    if (channelId) filter["#h"] = [channelId];
    return searchResponseFromEvents(await relayQuery([filter]));
  }

  async function getCanvas(args: Args) {
    const events = await relayQuery([
      { kinds: [KIND_CANVAS], "#h": [args.channelId as string], limit: 1 },
    ]);
    const event = events[0];
    return event
      ? {
          content: event.content,
          event_id: event.id,
          created_at: event.created_at,
          pubkey: event.pubkey,
        }
      : { content: "" };
  }

  async function setCanvas(args: Args) {
    const uuid = parseChannelUuid(args.channelId as string);
    const content = args.content as string;
    checkContent(content);
    const result = await submitEvent({
      kind: KIND_CANVAS,
      content,
      tags: [["h", uuid]],
    });
    return { ok: true, event_id: result.event_id };
  }

  return {
    get_feed: getFeed,
    search_messages: searchMessages,
    get_canvas: getCanvas,
    set_canvas: setCanvas,
  };
}
