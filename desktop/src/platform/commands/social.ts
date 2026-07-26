// Feed, search, and canvas command handlers.

import type { RelayEvent } from "@/shared/api/types";

import {
  type Args,
  checkContent,
  checkEventId,
  checkPubkey,
  firstTagValue,
  parseChannelUuid,
  type RelayContext,
} from "./context.ts";
import {
  KIND_APPROVAL_KINDS,
  KIND_CANVAS,
  KIND_DELETION,
  KIND_FORUM_COMMENT,
  KIND_FORUM_POST,
  KIND_REACTION,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_TEXT_NOTE,
} from "./kinds.ts";

function rawNote(event: RelayEvent) {
  return {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    content: event.content,
    tags: event.tags,
  };
}

function rawNotes(events: RelayEvent[], withCursor = true) {
  const notes = events.map(rawNote);
  const last = notes[notes.length - 1];
  return {
    notes,
    next_cursor:
      withCursor && last
        ? { before: last.created_at, before_id: last.id }
        : null,
  };
}

function eventTagIds(events: RelayEvent[]): Set<string> {
  return new Set(
    events.flatMap((event) =>
      event.tags.filter((tag) => tag[0] === "e" && tag[1]).map((tag) => tag[1]),
    ),
  );
}

function lastEventTag(event: RelayEvent, targets?: Set<string>) {
  for (let index = event.tags.length - 1; index >= 0; index -= 1) {
    const tag = event.tags[index];
    if (tag[0] === "e" && tag[1] && (!targets || targets.has(tag[1]))) {
      return tag[1];
    }
  }
  return undefined;
}

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

  async function getUserNotes(args: Args) {
    const pubkey = args.pubkey as string;
    checkPubkey(pubkey);
    const filter: Record<string, unknown> = {
      kinds: [KIND_TEXT_NOTE],
      authors: [pubkey],
      limit: Math.min((args.limit as number | null | undefined) ?? 20, 100),
    };
    if (typeof args.before === "number") filter.until = args.before;
    return rawNotes(await relayQuery([filter]));
  }

  async function getGlobalNotes(args: Args) {
    const filter: Record<string, unknown> = {
      kinds: [KIND_TEXT_NOTE],
      limit: Math.min((args.limit as number | null | undefined) ?? 50, 200),
    };
    if (typeof args.before === "number") filter.until = args.before;
    return rawNotes(await relayQuery([filter]));
  }

  async function getNotesTimeline(args: Args) {
    const pubkeys = args.pubkeys as string[];
    if (pubkeys.length === 0) return rawNotes([], false);
    if (pubkeys.length > 100) {
      throw new Error(`too many pubkeys (max 100, got ${pubkeys.length})`);
    }
    for (const pubkey of pubkeys) checkPubkey(pubkey);
    const perUser = Math.min(
      (args.limitPerUser as number | null | undefined) ?? 10,
      50,
    );
    const events = await relayQuery([
      {
        kinds: [KIND_TEXT_NOTE],
        authors: pubkeys,
        limit: Math.min(perUser * pubkeys.length, 200),
      },
    ]);
    events.sort((left, right) => right.created_at - left.created_at);
    return rawNotes(events.slice(0, 200), false);
  }

  async function getNote(args: Args) {
    const noteId = args.noteId as string;
    checkEventId(noteId, "note id");
    const events = await relayQuery([
      { kinds: [KIND_TEXT_NOTE], ids: [noteId], limit: 1 },
    ]);
    return events[0] ? rawNote(events[0]) : null;
  }

  async function getNoteReactions(args: Args) {
    const noteIds = args.noteIds as string[];
    if (noteIds.length === 0) return [];
    if (noteIds.length > 200) {
      throw new Error(`too many note ids (max 200, got ${noteIds.length})`);
    }
    for (const noteId of noteIds) checkEventId(noteId, "note id");
    const reactions = await relayQuery([
      { kinds: [KIND_REACTION], "#e": noteIds, limit: 500 },
    ]);
    const reactionIds = reactions.map((event) => event.id);
    const deletions =
      reactionIds.length > 0
        ? await relayQuery([
            { kinds: [KIND_DELETION], "#e": reactionIds, limit: 500 },
          ])
        : [];
    const deleted = eventTagIds(deletions);
    const targets = new Set(noteIds);
    const folded = new Map<string, Set<string>>();
    for (const reaction of reactions) {
      if (deleted.has(reaction.id)) continue;
      const noteId = lastEventTag(reaction, targets);
      if (!noteId) continue;
      const emoji = reaction.content || "+";
      const key = `${noteId}\u0000${emoji}`;
      const pubkeys = folded.get(key) ?? new Set<string>();
      pubkeys.add(reaction.pubkey);
      folded.set(key, pubkeys);
    }
    return [...folded]
      .map(([key, pubkeySet]) => {
        const [noteId, emoji] = key.split("\u0000");
        const pubkeys = [...pubkeySet].sort();
        return { note_id: noteId, emoji, count: pubkeys.length, pubkeys };
      })
      .sort(
        (left, right) =>
          left.note_id.localeCompare(right.note_id) ||
          left.emoji.localeCompare(right.emoji),
      );
  }

  async function getLikedNotes(args: Args) {
    const author = args.authorPubkey as string;
    checkPubkey(author);
    const cap = Math.min((args.limit as number | null | undefined) ?? 50, 200);
    const reactions = await relayQuery([
      {
        kinds: [KIND_REACTION],
        authors: [author],
        limit: Math.min(cap * 4, 1_000),
      },
    ]);
    reactions.sort((left, right) => right.created_at - left.created_at);
    const ids = reactions.map((event) => event.id);
    const deletions =
      ids.length > 0
        ? await relayQuery([
            {
              kinds: [KIND_DELETION],
              authors: [author],
              "#e": ids,
              limit: 500,
            },
          ])
        : [];
    const deleted = eventTagIds(deletions);
    const targetOrder: string[] = [];
    for (const reaction of reactions) {
      if (targetOrder.length >= cap || deleted.has(reaction.id)) continue;
      const target = lastEventTag(reaction);
      if (target && !targetOrder.includes(target)) targetOrder.push(target);
    }
    if (targetOrder.length === 0) return rawNotes([]);
    const notes = await relayQuery([
      { kinds: [KIND_TEXT_NOTE], ids: targetOrder, limit: cap },
    ]);
    const position = new Map(targetOrder.map((id, index) => [id, index]));
    notes.sort(
      (left, right) =>
        (position.get(left.id) ?? cap) - (position.get(right.id) ?? cap),
    );
    return rawNotes(notes.slice(0, cap));
  }

  async function publishNote(args: Args) {
    const content = args.content as string;
    checkContent(content);
    const tags: string[][] = [];
    const replyTo = args.replyTo as string | null | undefined;
    if (replyTo) {
      checkEventId(replyTo, "reply_to event id");
      tags.push(["e", replyTo, "", "reply"]);
    }
    const mentions = (args.mentionPubkeys as string[] | null | undefined) ?? [];
    if (mentions.length > 50) throw new Error("too many mentions (max 50)");
    for (const pubkey of new Set(
      mentions.map((value) => value.toLowerCase()),
    )) {
      checkPubkey(pubkey);
      tags.push(["p", pubkey]);
    }
    for (const tag of (args.mediaTags as string[][] | null | undefined) ?? []) {
      if (tag[0] !== "imeta") {
        throw new Error(`media tags must use 'imeta' prefix (got ${tag[0]})`);
      }
      tags.push(tag);
    }
    return submitEvent({ kind: KIND_TEXT_NOTE, content, tags });
  }

  async function getContactList(args: Args) {
    const pubkey = args.pubkey as string;
    checkPubkey(pubkey);
    const events = await relayQuery([
      { kinds: [3], authors: [pubkey], limit: 1 },
    ]);
    const event = events[0];
    return event
      ? rawNote(event)
      : { id: "", pubkey, created_at: 0, tags: [], content: "" };
  }

  async function setContactList(args: Args) {
    const contacts = args.contacts as Array<{
      pubkey: string;
      relay_url?: string | null;
      petname?: string | null;
    }>;
    if (contacts.length > 100) {
      throw new Error(`too many contacts (max 100, got ${contacts.length})`);
    }
    const seen = new Set<string>();
    const tags: string[][] = [];
    for (const contact of contacts) {
      const pubkey = contact.pubkey.toLowerCase();
      checkPubkey(pubkey);
      if (seen.has(pubkey)) continue;
      seen.add(pubkey);
      tags.push(["p", pubkey, contact.relay_url ?? "", contact.petname ?? ""]);
    }
    return submitEvent({ kind: 3, content: "", tags });
  }

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
    get_user_notes: getUserNotes,
    get_global_notes: getGlobalNotes,
    get_notes_timeline: getNotesTimeline,
    get_note: getNote,
    get_note_reactions: getNoteReactions,
    get_liked_notes: getLikedNotes,
    publish_note: publishNote,
    get_contact_list: getContactList,
    set_contact_list: setContactList,
    get_feed: getFeed,
    search_messages: searchMessages,
    get_canvas: getCanvas,
    set_canvas: setCanvas,
  };
}
