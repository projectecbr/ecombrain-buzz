import type { RelayEvent } from "@/shared/api/types";

import {
  type Args,
  checkEventId,
  parseChannelUuid,
  type RelayContext,
} from "./context.ts";
import {
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
} from "./kinds.ts";

function forumMessage(event: RelayEvent, channelId: string) {
  return {
    event_id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    kind: event.kind,
    created_at: event.created_at,
    channel_id: channelId,
    tags: event.tags,
    thread_summary: {
      reply_count: 0,
      descendant_count: 0,
      last_reply_at: null,
      participants: [],
    },
    reactions: null,
  };
}

function forumReply(event: RelayEvent, channelId: string, rootEventId: string) {
  let parent: string | null = null;
  let root: string | null = null;
  for (const tag of event.tags) {
    if (tag[0] !== "e" || !tag[1]) continue;
    if (tag[3] === "root") root = tag[1];
    else if (tag[3] === "reply") parent = tag[1];
    else parent ??= tag[1];
  }
  parent ??= rootEventId;
  root ??= rootEventId;
  return {
    event_id: event.id,
    pubkey: event.pubkey,
    content: event.content,
    kind: event.kind,
    created_at: event.created_at,
    channel_id: channelId,
    tags: event.tags,
    parent_event_id: parent,
    root_event_id: root,
    depth: parent === root ? 1 : 2,
    broadcast: false,
    reactions: null,
  };
}

export function forumHandlers(
  ctx: RelayContext,
): Record<string, (args: Args) => unknown | Promise<unknown>> {
  async function getForumPosts(args: Args) {
    const channelId = parseChannelUuid(args.channelId as string);
    const filter: Record<string, unknown> = {
      kinds: [KIND_FORUM_POST],
      "#h": [channelId],
      limit: Math.min((args.limit as number | null | undefined) ?? 20, 100),
    };
    if (typeof args.before === "number") filter.until = args.before;
    const messages = (await ctx.relayQuery([filter])).map((event) =>
      forumMessage(event, channelId),
    );
    return {
      messages,
      next_cursor: messages[messages.length - 1]?.created_at ?? null,
    };
  }

  async function getForumThread(args: Args) {
    const channelId = parseChannelUuid(args.channelId as string);
    const eventId = args.eventId as string;
    checkEventId(eventId, "forum event id");
    const events = await ctx.relayQuery([
      {
        ids: [eventId],
        kinds: [
          KIND_STREAM_MESSAGE,
          KIND_STREAM_MESSAGE_V2,
          KIND_FORUM_POST,
          KIND_FORUM_COMMENT,
        ],
      },
      {
        kinds: [KIND_STREAM_MESSAGE, KIND_FORUM_COMMENT],
        "#e": [eventId],
        "#h": [channelId],
      },
    ]);
    const root = events.find((event) => event.id === eventId);
    if (!root) throw new Error("forum thread root event not found");
    const replies = events
      .filter((event) => event.id !== eventId)
      .map((event) => forumReply(event, channelId, eventId));
    return {
      root: forumMessage(root, channelId),
      replies,
      total_replies: replies.length,
      next_cursor: null,
    };
  }

  return {
    get_forum_posts: getForumPosts,
    get_forum_thread: getForumThread,
  };
}
