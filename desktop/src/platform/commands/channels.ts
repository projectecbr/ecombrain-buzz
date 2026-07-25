// Channel command ports with the Rust-compatible snake_case response shapes.

import type { RelayEvent } from "@/shared/api/types";

import {
  type Args,
  checkPubkey,
  firstTagValue,
  hasTag,
  parseChannelUuid,
  type RelayContext,
  timestampToIso,
} from "./context.ts";
import {
  KIND_ADD_MEMBER,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_CHANNEL,
  KIND_DELETE_CHANNEL,
  KIND_DM_VISIBILITY,
  KIND_JOIN_CHANNEL,
  KIND_LEAVE_CHANNEL,
  KIND_REMOVE_MEMBER,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_UPDATE_CHANNEL,
} from "./kinds.ts";

export type RawChannelInfo = {
  id: string;
  name: string;
  channel_type: string;
  visibility: "open" | "private";
  description: string;
  topic: string | null;
  purpose: string | null;
  member_count: number;
  member_pubkeys: string[];
  last_message_at: string | null;
  archived_at: string | null;
  participants: string[];
  participant_pubkeys: string[];
  is_member: boolean;
  ttl_seconds: number | null;
  ttl_deadline: string | null;
};

function channelVisibilityFromEvent(ev: RelayEvent): "open" | "private" {
  const visibilityTag = firstTagValue(ev, "visibility");
  if (hasTag(ev, "public") || visibilityTag === "open") return "open";
  if (hasTag(ev, "private") || visibilityTag === "private") return "private";
  return "open";
}

function channelTypeFromEvent(ev: RelayEvent): string {
  const t = firstTagValue(ev, "t");
  if (t) return t;
  return hasTag(ev, "hidden") ? "dm" : "stream";
}

/** Port of `channel_info_from_event` (summary sidecar always absent). */
export function channelInfoFromEvent(
  ev: RelayEvent,
  isMember?: boolean,
): RawChannelInfo {
  const id = firstTagValue(ev, "d");
  if (!id) throw new Error("kind:39000 missing required `d` tag");
  const participantPubkeys = ev.tags
    .filter((t) => t[0] === "p" && t[1])
    .map((t) => t[1]);
  return {
    id,
    name: firstTagValue(ev, "name") ?? "",
    channel_type: channelTypeFromEvent(ev),
    visibility: channelVisibilityFromEvent(ev),
    description: firstTagValue(ev, "about") ?? "",
    topic: firstTagValue(ev, "topic") ?? null,
    purpose: firstTagValue(ev, "purpose") ?? null,
    member_count: 0,
    member_pubkeys: [],
    last_message_at: null,
    archived_at:
      firstTagValue(ev, "archived") === "true"
        ? timestampToIso(ev.created_at)
        : null,
    participants: [...participantPubkeys],
    participant_pubkeys: participantPubkeys,
    is_member: isMember ?? true,
    ttl_seconds: firstTagValue(ev, "ttl")
      ? Number(firstTagValue(ev, "ttl"))
      : null,
    ttl_deadline: firstTagValue(ev, "ttl_deadline") ?? null,
  };
}

/** Port of `channel_detail_from_event`. */
export function channelDetailFromEvent(ev: RelayEvent) {
  const id = firstTagValue(ev, "d");
  if (!id) throw new Error("kind:39000 missing required `d` tag");
  const createdAtIso = timestampToIso(ev.created_at);
  return {
    id,
    name: firstTagValue(ev, "name") ?? "",
    channel_type: channelTypeFromEvent(ev),
    visibility: channelVisibilityFromEvent(ev),
    description: firstTagValue(ev, "about") ?? "",
    topic: firstTagValue(ev, "topic") ?? null,
    topic_set_by: null,
    topic_set_at: null,
    purpose: firstTagValue(ev, "purpose") ?? null,
    purpose_set_by: null,
    purpose_set_at: null,
    created_by: ev.pubkey,
    created_at: createdAtIso,
    updated_at: createdAtIso,
    archived_at: firstTagValue(ev, "archived") === "true" ? createdAtIso : null,
    member_count: 0,
    topic_required: false,
    max_members: null,
    nip29_group_id: null,
    ttl_seconds: firstTagValue(ev, "ttl")
      ? Number(firstTagValue(ev, "ttl"))
      : null,
    ttl_deadline: firstTagValue(ev, "ttl_deadline") ?? null,
  };
}

export type RawChannelMemberInfo = {
  pubkey: string;
  role: string;
  is_agent: boolean;
  joined_at: string | null;
  display_name: string | null;
};

/** Port of `channel_members_from_event`. */
export function channelMembersFromEvent(ev: RelayEvent): {
  members: RawChannelMemberInfo[];
  next_cursor: string | null;
} {
  if (!firstTagValue(ev, "d")) {
    throw new Error("kind:39002 missing required `d` tag");
  }
  const seen = new Set<string>();
  const members: RawChannelMemberInfo[] = [];
  for (const tag of ev.tags) {
    if (tag[0] !== "p") continue;
    const pubkey = tag[1];
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    const role = tag[3] && tag[3] !== "" ? tag[3] : "member";
    members.push({
      pubkey,
      role,
      is_agent: role === "bot",
      joined_at: null,
      display_name: null,
    });
  }
  return { members, next_cursor: null };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

export function channelHandlers(
  ctx: RelayContext,
): Record<string, (args: Args) => unknown | Promise<unknown>> {
  const {
    relayQuery,
    relayQueryOrEmpty,
    relayQueryAll,
    submitEvent,
    myPubkey,
  } = ctx;

  async function getChannels(): Promise<RawChannelInfo[]> {
    const pubkey = await myPubkey();

    // Step 1: membership events mentioning me → channel ids.
    const memberEvents = await relayQueryAll({
      kinds: [KIND_CHANNEL_MEMBERS],
      "#p": [pubkey],
    });
    const channelIds = [
      ...new Set(
        memberEvents
          .map((ev) => firstTagValue(ev, "d"))
          .filter((d): d is string => typeof d === "string"),
      ),
    ].sort();

    // Step 2: metadata for member channels.
    const metaEvents =
      channelIds.length > 0
        ? await relayQuery([
            {
              kinds: [KIND_CHANNEL_METADATA],
              "#d": channelIds,
              limit: channelIds.length,
            },
          ])
        : [];

    // Step 3: all open channel metadata (channel browser).
    const openMetaEvents = await relayQueryAll({
      kinds: [KIND_CHANNEL_METADATA],
    });

    const memberDTags = new Set(
      metaEvents
        .map((ev) => firstTagValue(ev, "d"))
        .filter((d): d is string => typeof d === "string"),
    );

    const channels: RawChannelInfo[] = [];
    for (const ev of metaEvents) {
      try {
        channels.push(channelInfoFromEvent(ev, true));
      } catch {
        // Rust: `if let Ok(info)` — skip unconvertible events.
      }
    }
    for (const ev of openMetaEvents) {
      const d = firstTagValue(ev, "d");
      if (d && memberDTags.has(d)) continue;
      try {
        channels.push(channelInfoFromEvent(ev, false));
      } catch {
        // skip
      }
    }

    // Member counts + member_pubkeys from batched kind:39002.
    const allIds = channels.map((c) => c.id);
    if (allIds.length > 0) {
      const membersEvents = await relayQueryOrEmpty([
        { kinds: [KIND_CHANNEL_MEMBERS], "#d": allIds, limit: allIds.length },
      ]);
      const membership = new Map<
        string,
        { count: number; pubkeys: string[] }
      >();
      for (const ev of membersEvents) {
        const d = firstTagValue(ev, "d");
        if (!d) continue;
        try {
          const { members } = channelMembersFromEvent(ev);
          membership.set(d, {
            count: members.length,
            pubkeys: members.map((m) => m.pubkey),
          });
        } catch {
          // skip
        }
      }
      for (const channel of channels) {
        const info = membership.get(channel.id);
        if (info) {
          channel.member_count = info.count;
          channel.member_pubkeys = info.pubkeys;
        }
      }
    }

    // last_message_at: per-channel filters (single #h each — SQL-pushed).
    if (allIds.length > 0) {
      const messageEvents = await relayQueryOrEmpty(
        allIds.map((id) => ({
          kinds: [KIND_STREAM_MESSAGE, KIND_STREAM_MESSAGE_V2],
          "#h": [id],
          limit: 1,
        })),
      );
      const lastByChannel = new Map<string, number>();
      for (const ev of messageEvents) {
        const h = firstTagValue(ev, "h");
        if (!h) continue;
        const existing = lastByChannel.get(h);
        if (existing === undefined || ev.created_at > existing) {
          lastByChannel.set(h, ev.created_at);
        }
      }
      for (const channel of channels) {
        const ts = lastByChannel.get(channel.id);
        if (ts !== undefined) channel.last_message_at = timestampToIso(ts);
      }
    }

    // NIP-DV: drop DMs hidden in the viewer's kind:30622 snapshot.
    const visibilityEvents = await relayQueryOrEmpty([
      { kinds: [KIND_DM_VISIBILITY], "#p": [pubkey], limit: 1 },
    ]);
    const latest = visibilityEvents.reduce<RelayEvent | null>(
      (acc, ev) => (!acc || ev.created_at > acc.created_at ? ev : acc),
      null,
    );
    const hiddenDms = new Set(
      (latest?.tags ?? []).filter((t) => t[0] === "h").map((t) => t[1]),
    );
    return channels.filter(
      (c) => c.channel_type !== "dm" || !hiddenDms.has(c.id),
    );
  }

  async function createChannel(args: Args): Promise<RawChannelInfo> {
    const name = args.name as string;
    const channelType = args.channelType as string;
    const visibility = args.visibility as string;
    const description = args.description as string | undefined;
    const ttlSeconds = args.ttlSeconds as number | undefined;

    if (visibility !== "open" && visibility !== "private") {
      throw new Error(`invalid visibility: ${visibility}`);
    }
    if (channelType !== "stream" && channelType !== "forum") {
      throw new Error(`invalid channel_type: ${channelType}`);
    }

    const channelId = crypto.randomUUID();
    const tags: string[][] = [
      ["h", channelId],
      ["name", name],
      ["visibility", visibility],
      ["channel_type", channelType],
    ];
    if (description) tags.push(["about", description]);
    if (typeof ttlSeconds === "number") {
      tags.push(["ttl", String(ttlSeconds)]);
    }
    await ctx.bindRoom(channelId);
    await submitEvent({ kind: KIND_CREATE_CHANNEL, content: "", tags });

    const events = await relayQuery([
      { kinds: [KIND_CHANNEL_METADATA], "#d": [channelId], limit: 1 },
    ]);
    const ev = events[0];
    if (!ev) {
      throw new Error("channel created but metadata not yet available");
    }
    return channelInfoFromEvent(ev);
  }

  async function getChannelDetails(args: Args) {
    const events = await relayQuery([
      {
        kinds: [KIND_CHANNEL_METADATA],
        "#d": [args.channelId as string],
        limit: 1,
      },
    ]);
    const ev = events[0];
    if (!ev) throw new Error("channel not found");
    return channelDetailFromEvent(ev);
  }

  async function getChannelMembers(args: Args) {
    const events = await relayQuery([
      {
        kinds: [KIND_CHANNEL_MEMBERS],
        "#d": [args.channelId as string],
        limit: 1,
      },
    ]);
    const ev = events[0];
    if (!ev) throw new Error("channel members not found");
    const response = channelMembersFromEvent(ev);

    // Batch kind:0 profiles for display names. NOTE: the Rust command also
    // sets is_agent from a verified NIP-OA owner tag on the profile; that
    // verification is not ported (see command-map.md Deviations) — is_agent
    // comes from the membership role only.
    const pubkeys = response.members.map((m) => m.pubkey);
    if (pubkeys.length > 0) {
      const profileEvents = await relayQueryOrEmpty([
        { kinds: [0], authors: pubkeys, limit: pubkeys.length },
      ]);
      const displayNames = new Map<string, string | null>();
      for (const profileEvent of profileEvents) {
        try {
          const content = JSON.parse(profileEvent.content) as {
            display_name?: unknown;
            name?: unknown;
          };
          const displayName =
            typeof content.display_name === "string"
              ? content.display_name
              : typeof content.name === "string"
                ? content.name
                : null;
          displayNames.set(profileEvent.pubkey, displayName);
        } catch {
          // unparseable profile content — no display name
        }
      }
      for (const member of response.members) {
        if (member.role === "bot") member.is_agent = true;
        const displayName = displayNames.get(member.pubkey);
        if (member.display_name === null && displayName != null) {
          member.display_name = displayName;
        }
      }
    }

    return response;
  }

  async function updateChannel(args: Args) {
    const input = args.input as {
      channelId: string;
      name?: string | null;
      description?: string | null;
      visibility?: string | null;
      ttlSeconds?: number | null;
    };
    const uuid = parseChannelUuid(input.channelId);

    const name = input.name ?? undefined;
    const about = input.description ?? undefined;
    const visibility = input.visibility ?? undefined;
    // double_option: undefined = leave, null = clear, number = set.
    const ttl = input.ttlSeconds;

    if (
      name === undefined &&
      about === undefined &&
      visibility === undefined &&
      ttl === undefined
    ) {
      throw new Error(
        "at least one of name, about, visibility, or ttl must be provided",
      );
    }
    if (
      visibility !== undefined &&
      visibility !== "open" &&
      visibility !== "private"
    ) {
      throw new Error('visibility must be "open" or "private"');
    }

    const tags: string[][] = [["h", uuid]];
    if (name !== undefined) tags.push(["name", name]);
    if (about !== undefined) tags.push(["about", about]);
    if (visibility !== undefined) tags.push(["visibility", visibility]);
    if (ttl !== undefined) {
      tags.push(ttl === null ? ["ttl", ""] : ["ttl", String(ttl)]);
    }
    await submitEvent({ kind: KIND_UPDATE_CHANNEL, content: "", tags });

    const events = await relayQuery([
      { kinds: [KIND_CHANNEL_METADATA], "#d": [uuid], limit: 1 },
    ]);
    const ev = events[0];
    if (!ev) {
      throw new Error("channel updated but metadata not yet available");
    }
    return channelDetailFromEvent(ev);
  }

  async function simpleChannelCommand(
    args: Args,
    build: (uuid: string) => { kind: number; tags: string[][] },
  ): Promise<null> {
    const uuid = parseChannelUuid(args.channelId as string);
    const { kind, tags } = build(uuid);
    await submitEvent({ kind, content: "", tags });
    return null;
  }

  async function addChannelMembers(args: Args) {
    const uuid = parseChannelUuid(args.channelId as string);
    const pubkeys = args.pubkeys as string[];
    const role = args.role as string | undefined | null;

    let roleTag: string | null = null;
    if (role === "admin" || role === "bot" || role === "guest") {
      roleTag = role;
    } else if (role !== undefined && role !== null && role !== "member") {
      throw new Error(`invalid role: ${role}`);
    }

    const added: string[] = [];
    const errors: Array<{ pubkey: string; error: string }> = [];
    for (const pubkey of pubkeys) {
      try {
        checkPubkey(pubkey);
        const tags: string[][] = [
          ["h", uuid],
          ["p", pubkey.toLowerCase()],
        ];
        if (roleTag) tags.push(["role", roleTag]);
        await submitEvent({ kind: KIND_ADD_MEMBER, content: "", tags });
        added.push(pubkey);
      } catch (error) {
        errors.push({
          pubkey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { added, errors };
  }

  async function removeChannelMember(args: Args): Promise<null> {
    const uuid = parseChannelUuid(args.channelId as string);
    const pubkey = args.pubkey as string;
    checkPubkey(pubkey);
    await submitEvent({
      kind: KIND_REMOVE_MEMBER,
      content: "",
      tags: [
        ["h", uuid],
        ["p", pubkey.toLowerCase()],
      ],
    });
    return null;
  }

  async function changeChannelMemberRole(args: Args): Promise<null> {
    const uuid = parseChannelUuid(args.channelId as string);
    const pubkey = args.pubkey as string;
    const role = args.role as string;
    checkPubkey(pubkey);
    if (role === "owner") {
      throw new Error("cannot assign owner role — use transfer ownership");
    }
    if (!["admin", "member", "guest", "bot"].includes(role)) {
      throw new Error(`invalid role: ${role}`);
    }
    await submitEvent({
      kind: KIND_ADD_MEMBER,
      content: "",
      tags: [
        ["h", uuid],
        ["p", pubkey.toLowerCase()],
        ["role", role],
      ],
    });
    return null;
  }

  return {
    get_channels: getChannels,
    create_channel: createChannel,
    get_channel_details: getChannelDetails,
    get_channel_members: getChannelMembers,
    update_channel: updateChannel,
    set_channel_topic: (a) =>
      simpleChannelCommand(a, (uuid) => ({
        kind: KIND_UPDATE_CHANNEL,
        tags: [
          ["h", uuid],
          ["topic", a.topic as string],
        ],
      })),
    set_channel_purpose: (a) =>
      simpleChannelCommand(a, (uuid) => ({
        kind: KIND_UPDATE_CHANNEL,
        tags: [
          ["h", uuid],
          ["purpose", a.purpose as string],
        ],
      })),
    archive_channel: (a) =>
      simpleChannelCommand(a, (uuid) => ({
        kind: KIND_UPDATE_CHANNEL,
        tags: [
          ["h", uuid],
          ["archived", "true"],
        ],
      })),
    unarchive_channel: (a) =>
      simpleChannelCommand(a, (uuid) => ({
        kind: KIND_UPDATE_CHANNEL,
        tags: [
          ["h", uuid],
          ["archived", "false"],
        ],
      })),
    delete_channel: (a) =>
      simpleChannelCommand(a, (uuid) => ({
        kind: KIND_DELETE_CHANNEL,
        tags: [["h", uuid]],
      })),
    add_channel_members: addChannelMembers,
    remove_channel_member: removeChannelMember,
    change_channel_member_role: changeChannelMemberRole,
    join_channel: (a) =>
      simpleChannelCommand(a, (uuid) => ({
        kind: KIND_JOIN_CHANNEL,
        tags: [["h", uuid]],
      })),
    leave_channel: (a) =>
      simpleChannelCommand(a, (uuid) => ({
        kind: KIND_LEAVE_CHANNEL,
        tags: [["h", uuid]],
      })),
  };
}
