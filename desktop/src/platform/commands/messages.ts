// Direct-message, message, reaction, and timeline command handlers.

import type { RelayEvent } from "@/shared/api/types";

import type { SignEventInput } from "../types";
import { channelInfoFromEvent, type RawChannelInfo } from "./channels.ts";
import {
  type Args,
  checkContent,
  checkEventId,
  checkPubkey,
  parseChannelUuid,
  type RelayContext,
} from "./context.ts";
import {
  KIND_CANVAS,
  KIND_CHANNEL_METADATA,
  KIND_DELETION,
  KIND_DM_HIDE,
  KIND_DM_OPEN,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_HUDDLE_STARTED,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_STREAM_MESSAGE_EDIT,
  KIND_STREAM_MESSAGE_V2,
  KIND_SYSTEM_MESSAGE,
  KIND_TEXT_NOTE,
  MAX_EMOJI_CHARS,
  MAX_MENTIONS,
  TIMELINE_KINDS,
} from "./kinds.ts";

function mentionPTags(mentions: string[]): string[][] {
  if (mentions.length > MAX_MENTIONS) {
    throw new Error(`too many mentions (max ${MAX_MENTIONS})`);
  }
  const seen = new Set<string>();
  const tags: string[][] = [];
  for (const hex of mentions) {
    checkPubkey(hex);
    const lower = hex.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      tags.push(["p", lower]);
    }
  }
  return tags;
}

function imetaTags(tags: string[][]): string[][] {
  for (const tag of tags) {
    if (tag[0] !== "imeta" || tag.length < 2) {
      throw new Error("media tags must be non-empty 'imeta' tags");
    }
  }
  return tags.map((tag) => [...tag]);
}

function emojiTags(tags: string[][]): string[][] {
  for (const tag of tags) {
    if (tag[0] !== "emoji" || tag.length !== 3) {
      throw new Error("emoji tags must have prefix, shortcode, and URL");
    }
  }
  return tags.map((tag) => [...tag]);
}

function mentionReferenceTags(mentions: string[][]): string[][] {
  return mentions.map((mention) => {
    if (mention[0] !== "mention" || mention.length < 2) {
      throw new Error("mention reference tag missing pubkey");
    }
    checkPubkey(mention[1]);
    return ["mention", mention[1].toLowerCase()];
  });
}

type ThreadRef = { rootEventId: string; parentEventId: string };
type RawCursor = { created_at: number; event_id: string };

function threadTags(ref: ThreadRef): string[][] {
  if (ref.rootEventId === ref.parentEventId) {
    return [["e", ref.rootEventId, "", "reply"]];
  }
  return [
    ["e", ref.rootEventId, "", "root"],
    ["e", ref.parentEventId, "", "reply"],
  ];
}

export function messageHandlers(
  ctx: RelayContext,
): Record<string, (args: Args) => unknown | Promise<unknown>> {
  const { relayQuery, submitEvent, parseCommandResponse, myPubkey } = ctx;

  async function resolveThreadRef(parentEventId: string): Promise<ThreadRef> {
    checkEventId(parentEventId, "parent event ID");
    const events = await relayQuery([
      {
        ids: [parentEventId],
        kinds: [
          KIND_STREAM_MESSAGE,
          KIND_STREAM_MESSAGE_V2,
          KIND_FORUM_POST,
          KIND_FORUM_COMMENT,
          KIND_HUDDLE_STARTED,
        ],
        limit: 1,
      },
    ]);
    const parent = events[0];
    if (!parent) throw new Error("parent event not found");

    let root: string | undefined;
    let reply: string | undefined;
    for (const tag of parent.tags) {
      if (tag.length < 4 || tag[0] !== "e") continue;
      if (tag[3] === "root") root = tag[1];
      else if (tag[3] === "reply") reply = tag[1];
    }
    const rootHex = root ?? reply;
    return {
      rootEventId:
        rootHex && rootHex !== parentEventId ? rootHex : parentEventId,
      parentEventId,
    };
  }

  async function openDm(args: Args): Promise<RawChannelInfo> {
    const pubkeys = args.pubkeys as string[];
    if (!Array.isArray(pubkeys) || pubkeys.length === 0) {
      throw new Error("dm_open requires at least one pubkey");
    }
    const tags = pubkeys.map((pubkey) => {
      checkPubkey(pubkey);
      return ["p", pubkey.toLowerCase()];
    });
    const result = await submitEvent({ kind: KIND_DM_OPEN, content: "", tags });
    const ack = parseCommandResponse<{ channel_id: string }>(result.message);
    const events = await relayQuery([
      { kinds: [KIND_CHANNEL_METADATA], "#d": [ack.channel_id], limit: 1 },
    ]);
    if (!events[0]) {
      throw new Error("DM channel created but metadata not yet available");
    }
    return channelInfoFromEvent(events[0]);
  }

  async function hideDm(args: Args): Promise<null> {
    const channelId = args.channelId;
    if (typeof channelId !== "string" || channelId.length === 0) {
      throw new Error("channelId is required");
    }
    await submitEvent({
      kind: KIND_DM_HIDE,
      content: "",
      tags: [["h", channelId]],
    });
    return null;
  }

  async function sendChannelMessage(args: Args) {
    const uuid = parseChannelUuid(args.channelId as string);
    const content = (args.content as string).trim();
    const parentEventId = (args.parentEventId as string | null) ?? null;
    const media = imetaTags((args.mediaTags as string[][] | null) ?? []);
    const emoji = emojiTags((args.emojiTags as string[][] | null) ?? []);
    const mentionRefs = mentionReferenceTags(
      (args.mentionTags as string[][] | null) ?? [],
    );
    const mentions = mentionPTags(
      (args.mentionPubkeys as string[] | null) ?? [],
    );
    const kind = (args.kind as number | null) ?? KIND_STREAM_MESSAGE;

    let rootEventId: string | null = null;
    let event: SignEventInput;
    if (kind === KIND_FORUM_POST) {
      checkContent(content);
      event = {
        kind,
        content,
        tags: [["h", uuid], ...mentions, ...media, ...mentionRefs],
      };
    } else if (kind === KIND_FORUM_COMMENT) {
      if (!parentEventId) {
        throw new Error("forum comment requires parent_event_id");
      }
      const ref = await resolveThreadRef(parentEventId);
      rootEventId = ref.rootEventId;
      checkContent(content);
      event = {
        kind,
        content,
        tags: [
          ["h", uuid],
          ...threadTags(ref),
          ...mentions,
          ...media,
          ...mentionRefs,
        ],
      };
    } else {
      if (kind !== KIND_STREAM_MESSAGE) {
        throw new Error(`unsupported channel message kind: ${kind}`);
      }
      const ref = parentEventId ? await resolveThreadRef(parentEventId) : null;
      rootEventId = ref?.rootEventId ?? null;
      checkContent(content);
      event = {
        kind: KIND_STREAM_MESSAGE,
        content,
        tags: [
          ["h", uuid],
          ...(ref ? threadTags(ref) : []),
          ...mentions,
          ...media,
          ...emoji,
          ...mentionRefs,
        ],
      };
    }

    const result = await submitEvent(event);
    const depth =
      parentEventId === null
        ? 0
        : rootEventId !== null && parentEventId === rootEventId
          ? 1
          : rootEventId !== null
            ? 2
            : 1;
    return {
      event_id: result.event_id,
      parent_event_id: parentEventId,
      root_event_id: rootEventId,
      depth,
      created_at: Math.floor(Date.now() / 1000),
    };
  }

  async function editMessage(args: Args): Promise<null> {
    const uuid = parseChannelUuid(args.channelId as string);
    const eventId = args.eventId as string;
    checkEventId(eventId, "event ID");
    const content = (args.content as string).trim();
    const media = imetaTags((args.mediaTags as string[][] | null) ?? []);
    const emoji = emojiTags((args.emojiTags as string[][] | null) ?? []);
    if (content.length === 0 && media.length === 0) {
      throw new Error("edit must have content or attachments");
    }
    checkContent(content);
    await submitEvent({
      kind: KIND_STREAM_MESSAGE_EDIT,
      content,
      tags: [["h", uuid], ["e", eventId], ...media, ...emoji],
    });
    return null;
  }

  async function deleteMessage(args: Args): Promise<null> {
    const uuid = parseChannelUuid(args.channelId as string);
    const eventId = args.eventId as string;
    checkEventId(eventId, "event ID");
    await submitEvent({
      kind: KIND_DELETION,
      content: "",
      tags: [
        ["h", uuid],
        ["e", eventId],
      ],
    });
    return null;
  }

  async function addReaction(args: Args): Promise<null> {
    const eventId = args.eventId as string;
    checkEventId(eventId, "event ID");
    const emoji = (args.emoji as string).trim();
    const emojiUrl = (args.emojiUrl as string | null | undefined) ?? null;
    if ([...emoji].length > MAX_EMOJI_CHARS) {
      throw new Error(
        `emoji exceeds maximum length of ${MAX_EMOJI_CHARS} characters`,
      );
    }
    if (emojiUrl) {
      const shortcode = emoji.replace(/^:+/, "").replace(/:+$/, "");
      if (!shortcode) throw new Error("emoji shortcode must not be empty");
      await submitEvent({
        kind: KIND_REACTION,
        content: `:${shortcode}:`,
        tags: [
          ["e", eventId],
          ["emoji", shortcode, emojiUrl],
        ],
      });
    } else {
      await submitEvent({
        kind: KIND_REACTION,
        content: emoji,
        tags: [["e", eventId]],
      });
    }
    return null;
  }

  async function removeReaction(args: Args): Promise<null> {
    const pubkey = await myPubkey();
    const eventId = (args.eventId as string).trim();
    const emoji = (args.emoji as string).trim();
    const reactions = await relayQuery([
      { kinds: [KIND_REACTION], "#e": [eventId], authors: [pubkey] },
    ]);
    const reaction = reactions.find(
      (candidate) => candidate.content.trim() === emoji,
    );
    if (!reaction) {
      throw new Error("could not find your reaction event for this emoji");
    }
    await submitEvent({
      kind: KIND_DELETION,
      content: "",
      tags: [["e", reaction.id]],
    });
    return null;
  }

  async function getEvent(args: Args): Promise<string> {
    const events = await relayQuery([
      {
        ids: [args.eventId as string],
        kinds: [
          0,
          KIND_TEXT_NOTE,
          3,
          KIND_DELETION,
          KIND_REACTION,
          KIND_STREAM_MESSAGE,
          30078,
          KIND_STREAM_MESSAGE_V2,
          KIND_STREAM_MESSAGE_EDIT,
          KIND_STREAM_MESSAGE_DIFF,
          KIND_SYSTEM_MESSAGE,
          KIND_CANVAS,
          KIND_FORUM_POST,
          KIND_FORUM_COMMENT,
          KIND_HUDDLE_STARTED,
        ],
        limit: 1,
      },
    ]);
    if (!events[0]) throw new Error("event not found");
    return JSON.stringify(events[0]);
  }

  async function getThreadReplies(args: Args) {
    const cap = Math.min((args.limit as number | null) ?? 200, 500);
    const cursor = args.cursor as RawCursor | null;
    const filter: Record<string, unknown> = {
      "#e": [args.rootEventId as string],
      kinds: TIMELINE_KINDS,
      depth_limit: (args.depthLimit as number | null) ?? 64,
      limit: cap,
    };
    const channelId = (args.channelId as string | null) ?? null;
    if (channelId) filter["#h"] = [channelId];
    if (cursor) {
      filter.thread_cursor = cursor.created_at;
      filter.thread_cursor_id = cursor.event_id;
    }
    const events = await relayQuery([filter]);
    const last = events[events.length - 1];
    return {
      events,
      next_cursor:
        events.length >= cap && last
          ? { created_at: last.created_at, event_id: last.id }
          : null,
    };
  }

  async function getChannelMessagesBefore(args: Args) {
    const cap = Math.min((args.limit as number | null) ?? 200, 500);
    const beforeId = (args.beforeId as string | null) ?? null;
    const filter: Record<string, unknown> = {
      "#h": [args.channelId as string],
      kinds: TIMELINE_KINDS,
      until: args.before as number,
      limit: cap,
    };
    if (beforeId) filter.before_id = beforeId;
    const events = await relayQuery([filter]);
    const last = events[events.length - 1];
    return {
      events,
      next_cursor:
        events.length >= cap && last
          ? { created_at: last.created_at, event_id: last.id }
          : null,
    };
  }

  async function getChannelWindow(args: Args): Promise<RelayEvent[]> {
    const cap = Math.min((args.limitRows as number | null) ?? 50, 200);
    const cursor = args.cursor as RawCursor | null;
    const filter: Record<string, unknown> = {
      "#h": [args.channelId as string],
      kinds: TIMELINE_KINDS,
      limit: cap,
      top_level: true,
      include_summaries: true,
      include_aux: true,
    };
    if (cursor) {
      filter.until = cursor.created_at;
      filter.before_id = cursor.event_id;
    }
    return relayQuery([filter]);
  }

  return {
    open_dm: openDm,
    hide_dm: hideDm,
    send_channel_message: sendChannelMessage,
    edit_message: editMessage,
    delete_message: deleteMessage,
    add_reaction: addReaction,
    remove_reaction: removeReaction,
    get_event: getEvent,
    get_thread_replies: getThreadReplies,
    get_channel_messages_before: getChannelMessagesBefore,
    get_channel_window: getChannelWindow,
  };
}
