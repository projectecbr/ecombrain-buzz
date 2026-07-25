// Adapter C (web) — PlatformCommands over NIP-98-signed relay REST.
//
// Browser port of the Rust command layer (`src-tauri/src/commands/*.rs`) for
// the CORE domains in ecombrain/phase2/command-map.md: config, channels,
// dms, messages, feed/search, canvas. Every read is a `POST /query` with a
// JSON filter array; every write is a signed event `POST /events`; every
// request carries a NIP-98 kind:27235 Authorization header signed through
// the platform signer (`getSigner().signEvent`) — never raw keys. The local
// staging relay runs BUZZ_REQUIRE_AUTH_TOKEN=false but the header is sent
// unconditionally: production turns auth on.
//
// Result shapes match the Rust command results EXACTLY (snake_case JSON) —
// the `tauri*.ts` wrappers only (de)serialize and do their own
// snake_case→camelCase mapping, unchanged on both platforms.
//
// Error strings mirror `src-tauri/src/relay.rs` (`relay returned {status}:
// {message}`, `relay rejected event: {message}`, "not found" variants) so
// callers that pattern-match errors (e.g. getMyRelayMembership's
// `relay returned 404` check) behave identically.
//
// Commands outside the core map throw `not-ported-yet: <command>` — Task 4b
// fills them; there is deliberately no silent fallback.
//
// Node-compatible: the contract test (ecombrain/contract-tests/
// commands.test.mjs) injects `signer`, `baseUrl`, and `fetchFn` and drives
// this file directly under the node test runner.

import type { RelayEvent } from "@/shared/api/types";

// NOTE: relative runtime imports carry the explicit `.ts` extension so the
// node test runner (contract tests) resolves them; `allowImportingTsExtensions`
// + the bundler accept it everywhere else.
import { getSigner } from "./index.ts";
import type { PlatformCommands, PlatformSigner, SignEventInput } from "./types";

// ── Kind constants ───────────────────────────────────────────────────────────
//
// Keep in sync with shared/constants/kinds.ts. They are inlined here (rather
// than imported) because the contract test drives this file under the bare
// node test runner, which cannot resolve the `@/` path alias; type-only
// imports are fine (stripped), runtime imports are not.
const KIND_TEXT_NOTE = 1;
const KIND_DELETION = 5;
const KIND_REACTION = 7;
const KIND_STREAM_MESSAGE = 9;
const KIND_STREAM_MESSAGE_V2 = 40002;
const KIND_STREAM_MESSAGE_EDIT = 40003;
const KIND_STREAM_MESSAGE_DIFF = 40008;
const KIND_SYSTEM_MESSAGE = 40099;
const KIND_JOB_REQUEST = 43001;
const KIND_JOB_ACCEPTED = 43002;
const KIND_JOB_PROGRESS = 43003;
const KIND_JOB_RESULT = 43004;
const KIND_JOB_CANCEL = 43005;
const KIND_JOB_ERROR = 43006;
const KIND_FORUM_POST = 45001;
const KIND_FORUM_COMMENT = 45003;
const KIND_HUDDLE_STARTED = 48100;
const KIND_DM_VISIBILITY = 30622;

/** NIP-98 HTTP auth. */
const KIND_HTTP_AUTH = 27235;
/** NIP-29 channel metadata / membership. */
const KIND_CHANNEL_METADATA = 39000;
const KIND_CHANNEL_MEMBERS = 39002;
/** Channel admin/membership command kinds (see src-tauri/src/events.rs). */
const KIND_ADD_MEMBER = 9000;
const KIND_REMOVE_MEMBER = 9001;
const KIND_UPDATE_CHANNEL = 9002;
const KIND_CREATE_CHANNEL = 9007;
const KIND_DELETE_CHANNEL = 9008;
const KIND_JOIN_CHANNEL = 9021;
const KIND_LEAVE_CHANNEL = 9022;
/** NIP-DV DM open/hide command kinds. */
const KIND_DM_OPEN = 41010;
const KIND_DM_HIDE = 41012;
/** Channel canvas. */
const KIND_CANVAS = 40100;
/** Workflow approval-request kinds (get_feed needs_action section). */
const KIND_APPROVAL_KINDS = [46010, 46011, 46012];

/**
 * Timeline content kinds — mirror of `TIMELINE_KINDS` in
 * commands/messages.rs + commands/channel_window.rs (11 kinds). None are in
 * the relay's P_GATED_KINDS, which is load-bearing: the bridge p-gate
 * rejects kindless/p-gated filters before the thread/keyset routing runs.
 */
const TIMELINE_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_HUDDLE_STARTED,
];

// Validation caps — mirror src-tauri/src/events.rs.
const MAX_CONTENT_BYTES = 64 * 1024;
const MAX_MENTIONS = 50;
const MAX_EMOJI_CHARS = 64;
/** get_channels directory page size — mirror of DIRECTORY_PAGE_SIZE. */
const DIRECTORY_PAGE_SIZE = 500;

// ── Options ──────────────────────────────────────────────────────────────────

export type BrowserCommandsOptions = {
  /** Signer for NIP-98 auth + event signing. Default: `getSigner()`. */
  signer?: PlatformSigner;
  /**
   * Relay HTTP base URL (e.g. `http://localhost:3335`). Default: resolved
   * per call from the active workspace in localStorage (matching the Rust
   * workspace-override precedence), then `VITE_RELAY_URL`, then same-origin.
   */
  baseUrl?: string;
  /** fetch implementation. Default: `globalThis.fetch`. */
  fetchFn?: typeof fetch;
};

// ── Relay URL resolution (web runtime) ───────────────────────────────────────

const WORKSPACES_KEY = "buzz-workspaces";
const ACTIVE_WORKSPACE_KEY = "buzz-active-workspace-id";

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Active workspace relay URL (ws://) from localStorage, if any. */
function workspaceRelayWsUrl(): string | null {
  const store = safeLocalStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(WORKSPACES_KEY);
    if (!raw) return null;
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return null;
    const activeId = store.getItem(ACTIVE_WORKSPACE_KEY);
    const active =
      list.find(
        (w) =>
          w !== null &&
          typeof w === "object" &&
          (w as { id?: unknown }).id === activeId,
      ) ?? list[0];
    const url = (active as { relayUrl?: unknown } | undefined)?.relayUrl;
    return typeof url === "string" && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** Mirror of `relay_http_base_url` in src-tauri/src/relay.rs. */
export function relayWsToHttpBase(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("wss://")) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith("ws://")) return `http://${trimmed.slice(5)}`;
  return trimmed;
}

/** Inverse of relayWsToHttpBase, for get_relay_ws_url from an HTTP base. */
function relayHttpToWsUrl(httpUrl: string): string {
  const trimmed = httpUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}`;
  return trimmed;
}

function sameOriginWsUrl(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}`;
}

function envRelayUrl(): string | null {
  const url = import.meta.env?.VITE_RELAY_URL;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Default relay WS URL — no workspace override (get_default_relay_url).
 * Falls back to same-origin when the web bundle is served by the relay.
 */
function defaultRelayWsUrl(): string {
  const url = envRelayUrl() ?? sameOriginWsUrl();
  if (!url) {
    throw new Error(
      "no relay URL configured: add a workspace or set VITE_RELAY_URL",
    );
  }
  return url;
}

// ── Crypto / encoding helpers ────────────────────────────────────────────────

const textEncoder = new TextEncoder();

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    textEncoder.encode(text),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** Base64 for arbitrary UTF-8 JSON (btoa alone is Latin-1 only). */
function base64Utf8(text: string): string {
  const bytes = textEncoder.encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ── Tag helpers (ports of nostr_convert internals) ───────────────────────────

function firstTagValue(event: RelayEvent, name: string): string | undefined {
  const tag = event.tags.find((t) => t[0] === name);
  return tag?.[1];
}

function hasTag(event: RelayEvent, name: string): boolean {
  return event.tags.some((t) => t[0] === name);
}

/** Rust `timestamp_to_iso`: RFC-3339 without millis (`YYYY-MM-DDTHH:MM:SSZ`). */
function timestampToIso(secs: number): string {
  return `${new Date(secs * 1000).toISOString().slice(0, 19)}Z`;
}

// ── Event validation + tag builders (ports of src-tauri/src/events.rs) ──────

function checkContent(content: string): void {
  const bytes = textEncoder.encode(content).length;
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(
      `content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes (got ${bytes})`,
    );
  }
}

function checkPubkey(pubkey: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    throw new Error(
      `pubkey must be a 64-character hex string (got ${pubkey.length} chars)`,
    );
  }
}

function checkEventId(eventId: string, what: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(eventId)) {
    throw new Error(`invalid ${what}: ${eventId}`);
  }
}

function parseChannelUuid(channelId: string): string {
  if (
    !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      channelId,
    )
  ) {
    throw new Error(`invalid channel UUID: ${channelId}`);
  }
  // Rust Uuid::to_string() lowercases.
  return channelId.toLowerCase();
}

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

/** Validate + pass through `["imeta", ...]` tags (no forged h/e/p tags). */
function imetaTags(mediaTags: string[][]): string[][] {
  for (const tag of mediaTags) {
    if (tag[0] !== "imeta") {
      throw new Error(`media tags must use 'imeta' prefix (got "${tag[0]}")`);
    }
  }
  return mediaTags.map((t) => [...t]);
}

/** Validate + pass through `["emoji", shortcode, url]` tags. */
function emojiTags(emojiTagList: string[][]): string[][] {
  for (const tag of emojiTagList) {
    if (tag[0] !== "emoji") {
      throw new Error(`emoji tags must use 'emoji' prefix (got "${tag[0]}")`);
    }
  }
  return emojiTagList.map((t) => [...t]);
}

/** Validate + pass through `["mention", pubkey, ...]` reference tags. */
function mentionReferenceTags(mentions: string[][]): string[][] {
  return mentions.map((mention) => {
    if (mention[0] !== "mention") {
      throw new Error(
        `mention reference tags must use 'mention' prefix (got "${mention[0]}")`,
      );
    }
    const pubkey = mention[1];
    if (!pubkey) throw new Error("mention reference tag missing pubkey");
    checkPubkey(pubkey);
    return ["mention", pubkey.toLowerCase()];
  });
}

type ThreadRef = { rootEventId: string; parentEventId: string };

function threadTags(tr: ThreadRef): string[][] {
  if (tr.rootEventId === tr.parentEventId) {
    return [["e", tr.rootEventId, "", "reply"]];
  }
  return [
    ["e", tr.rootEventId, "", "root"],
    ["e", tr.parentEventId, "", "reply"],
  ];
}

// ── nostr_convert ports: kind:39000 / 39002 → RawChannel shapes ─────────────
//
// These produce the exact snake_case JSON the Rust commands return (the
// tauri.ts wrappers map them to camelCase, unchanged).

type RawChannelInfo = {
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
function channelInfoFromEvent(
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
function channelDetailFromEvent(ev: RelayEvent) {
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

type RawChannelMemberInfo = {
  pubkey: string;
  role: string;
  is_agent: boolean;
  joined_at: string | null;
  display_name: string | null;
};

/** Port of `channel_members_from_event`. */
function channelMembersFromEvent(ev: RelayEvent): {
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

/** Port of `feed_item_from_event`. */
function feedItemFromEvent(ev: RelayEvent, category: string) {
  return {
    id: ev.id,
    kind: ev.kind,
    pubkey: ev.pubkey,
    content: ev.content,
    created_at: ev.created_at,
    channel_id: firstTagValue(ev, "h") ?? null,
    channel_name: "",
    channel_type: null,
    tags: ev.tags,
    category,
  };
}

/** Port of `search_response_from_events`. */
function searchResponseFromEvents(events: RelayEvent[]) {
  const total = events.length;
  const hits = events.map((ev, idx) => ({
    event_id: ev.id,
    content: ev.content,
    kind: ev.kind,
    pubkey: ev.pubkey,
    channel_id: firstTagValue(ev, "h") ?? null,
    channel_name: null,
    created_at: ev.created_at,
    score: total <= 1 ? 1.0 : 1.0 - idx / total,
  }));
  return { hits, found: hits.length };
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createBrowserCommands(
  options: BrowserCommandsOptions = {},
): PlatformCommands {
  const signer = options.signer ?? getSigner();
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  /** Relay HTTP base URL, resolved per call (workspace switches apply). */
  function baseUrl(): string {
    if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
    const wsUrl = workspaceRelayWsUrl() ?? defaultRelayWsUrl();
    return relayWsToHttpBase(wsUrl);
  }

  // ── NIP-98 auth + HTTP helpers ───────────────────────────────────────────

  /** Mirror of `build_nip98_auth_header` (u/method/payload/nonce tags). */
  async function nip98Header(
    method: "POST" | "GET",
    url: string,
    body: string,
  ): Promise<string> {
    const event = await signer.signEvent({
      kind: KIND_HTTP_AUTH,
      content: "",
      tags: [
        ["u", url],
        ["method", method],
        ["payload", await sha256Hex(body)],
        ["nonce", crypto.randomUUID()],
      ],
    });
    return `Nostr ${base64Utf8(JSON.stringify(event))}`;
  }

  /** Mirror of `relay_error_message`. */
  async function relayErrorMessage(response: Response): Promise<string> {
    const status = `${response.status} ${response.statusText}`.trim();
    let body = "";
    try {
      body = await response.text();
    } catch {
      return `relay returned ${status}`;
    }
    try {
      const value: unknown = JSON.parse(body);
      if (value !== null && typeof value === "object") {
        const message = (value as { message?: unknown }).message;
        if (typeof message === "string") {
          return `relay returned ${status}: ${message}`;
        }
        const error = (value as { error?: unknown }).error;
        if (typeof error === "string") {
          return `relay returned ${status}: ${error}`;
        }
      }
    } catch {
      // Non-JSON body: status only — no raw body in the UI.
    }
    return `relay returned ${status}`;
  }

  async function relayPost<T>(path: string, body: string): Promise<T> {
    const url = `${baseUrl()}${path}`;
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: "POST",
        headers: {
          Authorization: await nip98Header("POST", url, body),
          "Content-Type": "application/json",
        },
        body,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!response.ok) {
      throw new Error(await relayErrorMessage(response));
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error("relay returned malformed response: not valid JSON");
    }
  }

  /** Mirror of `query_relay`. */
  function relayQuery(
    filters: Array<Record<string, unknown>>,
  ): Promise<RelayEvent[]> {
    return relayPost<RelayEvent[]>("/query", JSON.stringify(filters));
  }

  /** Best-effort query: Rust uses `.unwrap_or_default()` in several places. */
  async function relayQueryOrEmpty(
    filters: Array<Record<string, unknown>>,
  ): Promise<RelayEvent[]> {
    try {
      return await relayQuery(filters);
    } catch {
      return [];
    }
  }

  /** Mirror of `query_relay_all` (composite until/before_id paging). */
  async function relayQueryAll(
    filter: Record<string, unknown>,
  ): Promise<RelayEvent[]> {
    const paged: Record<string, unknown> = {
      ...filter,
      limit: DIRECTORY_PAGE_SIZE,
    };
    const all: RelayEvent[] = [];
    for (;;) {
      const page = await relayQuery([paged]);
      const done = page.length < DIRECTORY_PAGE_SIZE;
      if (!done) {
        const last = page[page.length - 1];
        paged.until = last.created_at;
        paged.before_id = last.id;
      }
      all.push(...page);
      if (done) return all;
    }
  }

  type SubmitEventResponse = {
    event_id: string;
    accepted: boolean;
    message: string;
  };

  /** Mirror of `submit_event`: sign via the platform signer, POST /events. */
  async function submitEvent(
    input: SignEventInput,
  ): Promise<SubmitEventResponse> {
    const signed = await signer.signEvent(input);
    const result = await relayPost<SubmitEventResponse>(
      "/events",
      JSON.stringify(signed),
    );
    if (!result.accepted) {
      throw new Error(`relay rejected event: ${result.message}`);
    }
    return result;
  }

  /** Mirror of `parse_command_response` ("response:{json}" or raw JSON). */
  function parseCommandResponse<T>(message: string): T {
    const json = message.startsWith("response:")
      ? message.slice("response:".length)
      : message;
    try {
      return JSON.parse(json) as T;
    } catch (error) {
      if (message.startsWith("response:")) {
        throw new Error(`response parse failed: ${error}`);
      }
      throw new Error(
        `expected 'response:' prefix or valid JSON, got: ${message} (${error})`,
      );
    }
  }

  /** Mirror of `resolve_thread_ref`: fetch parent, walk NIP-10 e-tags. */
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
      if (tag.length >= 4 && tag[0] === "e") {
        if (tag[3] === "root") root = tag[1];
        else if (tag[3] === "reply") reply = tag[1];
      }
    }
    const rootHex = root ?? reply;
    const rootEventId =
      rootHex && rootHex !== parentEventId ? rootHex : parentEventId;
    return { rootEventId, parentEventId };
  }

  // ── Domain handlers ──────────────────────────────────────────────────────

  type Args = Record<string, unknown>;

  async function myPubkey(): Promise<string> {
    return signer.getPublicKey();
  }

  // config / relay URL — client-side, no relay call.

  function getRelayWsUrl(): string {
    if (options.baseUrl) return relayHttpToWsUrl(options.baseUrl);
    return workspaceRelayWsUrl() ?? defaultRelayWsUrl();
  }

  function getRelayHttpUrl(): string {
    return baseUrl();
  }

  function getDefaultRelayUrl(): string {
    if (options.baseUrl) return relayHttpToWsUrl(options.baseUrl);
    return defaultRelayWsUrl();
  }

  // channels — ports of commands/channels.rs.

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

  // dms — ports of commands/dms.rs.

  async function openDm(args: Args): Promise<RawChannelInfo> {
    const pubkeys = args.pubkeys as string[];
    if (pubkeys.length === 0) {
      throw new Error("dm_open requires at least one pubkey");
    }
    const tags = pubkeys.map((pk) => {
      checkPubkey(pk);
      return ["p", pk.toLowerCase()];
    });
    const result = await submitEvent({ kind: KIND_DM_OPEN, content: "", tags });
    const ack = parseCommandResponse<{ channel_id: string }>(result.message);

    const events = await relayQuery([
      { kinds: [KIND_CHANNEL_METADATA], "#d": [ack.channel_id], limit: 1 },
    ]);
    const ev = events[0];
    if (!ev) {
      throw new Error("DM channel created but metadata not yet available");
    }
    return channelInfoFromEvent(ev);
  }

  // messages — ports of commands/messages.rs.

  async function sendChannelMessage(args: Args) {
    const channelId = args.channelId as string;
    const uuid = parseChannelUuid(channelId);
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
    const kindNum = (args.kind as number | null) ?? KIND_STREAM_MESSAGE;

    let resolvedRoot: string | null = null;
    let template: SignEventInput;

    if (kindNum === KIND_FORUM_POST) {
      checkContent(content);
      template = {
        kind: KIND_FORUM_POST,
        content,
        tags: [["h", uuid], ...mentions, ...media, ...mentionRefs],
      };
    } else if (kindNum === KIND_FORUM_COMMENT) {
      if (!parentEventId) {
        throw new Error("forum comment requires parent_event_id");
      }
      const threadRef = await resolveThreadRef(parentEventId);
      resolvedRoot = threadRef.rootEventId;
      checkContent(content);
      template = {
        kind: KIND_FORUM_COMMENT,
        content,
        tags: [
          ["h", uuid],
          ...threadTags(threadRef),
          ...mentions,
          ...media,
          ...mentionRefs,
        ],
      };
    } else {
      let threadRef: ThreadRef | null = null;
      if (parentEventId) {
        threadRef = await resolveThreadRef(parentEventId);
        resolvedRoot = threadRef.rootEventId;
      }
      checkContent(content);
      template = {
        kind: kindNum,
        content,
        tags: [
          ["h", uuid],
          ...(threadRef ? threadTags(threadRef) : []),
          ...mentions,
          ...media,
          ...emoji,
          ...mentionRefs,
        ],
      };
    }

    const result = await submitEvent(template);
    const depth =
      parentEventId === null
        ? 0
        : resolvedRoot !== null && parentEventId === resolvedRoot
          ? 1
          : resolvedRoot !== null
            ? 2
            : 1;

    return {
      event_id: result.event_id,
      parent_event_id: parentEventId,
      root_event_id: resolvedRoot,
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
      // NIP-30 custom emoji (buzz-sdk build_custom_emoji_reaction): content
      // is `:shortcode:`, plus one ["emoji", shortcode, url] tag.
      const shortcode = emoji.replace(/^:+/, "").replace(/:+$/, "");
      if (shortcode.length === 0) {
        throw new Error("emoji shortcode must not be empty");
      }
      await submitEvent({
        kind: KIND_REACTION,
        content: `:${shortcode}:`,
        tags: [
          ["e", eventId],
          ["emoji", shortcode, emojiUrl],
        ],
      });
      return null;
    }

    await submitEvent({
      kind: KIND_REACTION,
      content: emoji,
      tags: [["e", eventId]],
    });
    return null;
  }

  async function removeReaction(args: Args): Promise<null> {
    const pubkey = await myPubkey();
    const target = (args.eventId as string).trim();
    const emoji = (args.emoji as string).trim();

    const reactions = await relayQuery([
      { kinds: [KIND_REACTION], "#e": [target], authors: [pubkey] },
    ]);
    const reaction = reactions.find((ev) => ev.content.trim() === emoji);
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
    const ev = events[0];
    if (!ev) throw new Error("event not found");
    return JSON.stringify(ev);
  }

  type RawCursor = { created_at: number; event_id: string };

  async function getThreadReplies(args: Args) {
    const limit = args.limit as number | null;
    const depthLimit = args.depthLimit as number | null;
    const cursor = args.cursor as RawCursor | null;
    const cap = Math.min(limit ?? 200, 500);

    const filter: Record<string, unknown> = {
      "#e": [args.rootEventId as string],
      kinds: TIMELINE_KINDS,
      // depth_limit activates the relay's thread-subtree bridge path.
      depth_limit: depthLimit ?? 64,
      limit: cap,
    };
    const channelId = (args.channelId as string | null) ?? null;
    if (channelId) filter["#h"] = [channelId];
    if (cursor) {
      filter.thread_cursor = cursor.created_at;
      filter.thread_cursor_id = cursor.event_id;
    }

    const events = await relayQuery([filter]);
    const next_cursor: RawCursor | null =
      events.length >= cap && events.length > 0
        ? {
            created_at: events[events.length - 1].created_at,
            event_id: events[events.length - 1].id,
          }
        : null;
    return { events, next_cursor };
  }

  async function getChannelMessagesBefore(args: Args) {
    const limit = args.limit as number | null;
    const beforeId = (args.beforeId as string | null) ?? null;
    const cap = Math.min(limit ?? 200, 500);

    const filter: Record<string, unknown> = {
      "#h": [args.channelId as string],
      kinds: TIMELINE_KINDS,
      until: args.before as number,
      limit: cap,
    };
    // `before_id` is the bridge's composite tiebreak field (requires until).
    if (beforeId) filter.before_id = beforeId;

    const events = await relayQuery([filter]);
    const next_cursor: RawCursor | null =
      events.length >= cap && events.length > 0
        ? {
            created_at: events[events.length - 1].created_at,
            event_id: events[events.length - 1].id,
          }
        : null;
    return { events, next_cursor };
  }

  async function getChannelWindow(args: Args): Promise<RelayEvent[]> {
    const limitRows = args.limitRows as number | null;
    const cursor = args.cursor as RawCursor | null;
    const cap = Math.min(limitRows ?? 50, 200);

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

  // feed / search — ports of the read half of commands/messages.rs.

  async function getFeed(args: Args) {
    const since = (args.since as number | null | undefined) ?? null;
    const limit = args.limit as number | null | undefined;
    const types = args.types as string | null | undefined;
    const cap = Math.min(limit ?? 50, 100);

    const wantMentions = types
      ? types.split(",").some((s) => s.trim() === "mentions")
      : true;
    const wantNeedsAction = types
      ? types.split(",").some((s) => s.trim() === "needs_action")
      : true;

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
    if (since !== null) mentionFilter.since = since;
    const approvalFilter: Record<string, unknown> = {
      kinds: KIND_APPROVAL_KINDS,
      "#p": [pubkey],
      limit: 20,
    };
    if (since !== null) approvalFilter.since = since;

    const mentionEvents = wantMentions
      ? await relayQueryOrEmpty([mentionFilter])
      : [];
    const approvalEvents = wantNeedsAction
      ? await relayQueryOrEmpty([approvalFilter])
      : [];

    const mentions = mentionEvents.map((ev) =>
      feedItemFromEvent(ev, "mentions"),
    );
    const needsAction = approvalEvents.map((ev) =>
      feedItemFromEvent(ev, "needs_action"),
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
    const limit = args.limit as number | null | undefined;
    const cap = Math.min(limit ?? 20, 100);

    const filter: Record<string, unknown> = {
      kinds: [
        KIND_STREAM_MESSAGE,
        KIND_STREAM_MESSAGE_V2,
        KIND_FORUM_POST,
        KIND_FORUM_COMMENT,
      ],
      search: (args.q as string).trim(),
      // Bridge-only extension: prefix mode for the topbar typeahead.
      search_mode: "prefix",
      limit: cap,
    };
    const channelId = (args.channelId as string | null | undefined) ?? null;
    if (channelId) filter["#h"] = [channelId];

    const events = await relayQuery([filter]);
    return searchResponseFromEvents(events);
  }

  // canvas — ports of commands/canvas.rs.

  async function getCanvas(args: Args) {
    const events = await relayQuery([
      { kinds: [KIND_CANVAS], "#h": [args.channelId as string], limit: 1 },
    ]);
    const ev = events[0];
    if (!ev) return { content: "" };
    return {
      content: ev.content,
      event_id: ev.id,
      created_at: ev.created_at,
      pubkey: ev.pubkey,
    };
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

  // ── Dispatch ─────────────────────────────────────────────────────────────

  function notPorted(command: string): never {
    throw new Error(
      `not-ported-yet: ${command} (see ecombrain/phase2/command-map.md)`,
    );
  }

  return {
    async call<T>(command: string, args?: unknown): Promise<T> {
      const a = (args ?? {}) as Args;
      let result: unknown;
      switch (command) {
        // config / relay URL
        case "get_relay_ws_url":
          result = getRelayWsUrl();
          break;
        case "get_relay_http_url":
          result = getRelayHttpUrl();
          break;
        case "get_default_relay_url":
          result = getDefaultRelayUrl();
          break;
        case "is_shared_identity":
          result = false;
          break;

        // channels
        case "get_channels":
          result = await getChannels();
          break;
        case "create_channel":
          result = await createChannel(a);
          break;
        case "get_channel_details":
          result = await getChannelDetails(a);
          break;
        case "get_channel_members":
          result = await getChannelMembers(a);
          break;
        case "update_channel":
          result = await updateChannel(a);
          break;
        case "set_channel_topic":
          result = await simpleChannelCommand(a, (uuid) => ({
            kind: KIND_UPDATE_CHANNEL,
            tags: [
              ["h", uuid],
              ["topic", a.topic as string],
            ],
          }));
          break;
        case "set_channel_purpose":
          result = await simpleChannelCommand(a, (uuid) => ({
            kind: KIND_UPDATE_CHANNEL,
            tags: [
              ["h", uuid],
              ["purpose", a.purpose as string],
            ],
          }));
          break;
        case "archive_channel":
          result = await simpleChannelCommand(a, (uuid) => ({
            kind: KIND_UPDATE_CHANNEL,
            tags: [
              ["h", uuid],
              ["archived", "true"],
            ],
          }));
          break;
        case "unarchive_channel":
          result = await simpleChannelCommand(a, (uuid) => ({
            kind: KIND_UPDATE_CHANNEL,
            tags: [
              ["h", uuid],
              ["archived", "false"],
            ],
          }));
          break;
        case "delete_channel":
          result = await simpleChannelCommand(a, (uuid) => ({
            kind: KIND_DELETE_CHANNEL,
            tags: [["h", uuid]],
          }));
          break;
        case "add_channel_members":
          result = await addChannelMembers(a);
          break;
        case "remove_channel_member":
          result = await removeChannelMember(a);
          break;
        case "change_channel_member_role":
          result = await changeChannelMemberRole(a);
          break;
        case "join_channel":
          result = await simpleChannelCommand(a, (uuid) => ({
            kind: KIND_JOIN_CHANNEL,
            tags: [["h", uuid]],
          }));
          break;
        case "leave_channel":
          result = await simpleChannelCommand(a, (uuid) => ({
            kind: KIND_LEAVE_CHANNEL,
            tags: [["h", uuid]],
          }));
          break;

        // dms
        case "open_dm":
          result = await openDm(a);
          break;
        case "hide_dm":
          // Rust build_dm_hide takes the id as-is (no UUID validation).
          result = await (async () => {
            await submitEvent({
              kind: KIND_DM_HIDE,
              content: "",
              tags: [["h", a.channelId as string]],
            });
            return null;
          })();
          break;

        // messages
        case "send_channel_message":
          result = await sendChannelMessage(a);
          break;
        case "edit_message":
          result = await editMessage(a);
          break;
        case "delete_message":
          result = await deleteMessage(a);
          break;
        case "add_reaction":
          result = await addReaction(a);
          break;
        case "remove_reaction":
          result = await removeReaction(a);
          break;
        case "get_event":
          result = await getEvent(a);
          break;
        case "get_thread_replies":
          result = await getThreadReplies(a);
          break;
        case "get_channel_messages_before":
          result = await getChannelMessagesBefore(a);
          break;
        case "get_channel_window":
          result = await getChannelWindow(a);
          break;

        // feed / search
        case "get_feed":
          result = await getFeed(a);
          break;
        case "search_messages":
          result = await searchMessages(a);
          break;

        // canvas
        case "get_canvas":
          result = await getCanvas(a);
          break;
        case "set_canvas":
          result = await setCanvas(a);
          break;

        default:
          notPorted(command);
      }
      return result as T;
    },
  };
}
