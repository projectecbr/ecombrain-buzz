// Shared context for the browser command adapter domains.
//
// `createRelayContext` bundles everything the per-domain handler modules
// (channels.ts, messages.ts, …) close over: the signer, the NIP-98-signed
// relay HTTP helpers (/query, /events), event validation, and tag helpers.
// Split out of commands.browser.ts in Task 4b — a mechanical move; behavior
// is unchanged.
//
// Every request carries a NIP-98 kind:27235 Authorization header signed
// through the platform signer (`getSigner().signEvent`) — never raw keys.
// The local staging relay runs BUZZ_REQUIRE_AUTH_TOKEN=false but the header
// is sent unconditionally: production turns auth on.
//
// Error strings mirror `src-tauri/src/relay.rs` (`relay returned {status}:
// {message}`, `relay rejected event: {message}`) so callers that
// pattern-match errors behave identically.
//
// Node-compatible: the contract tests inject `signer`, `baseUrl`, and
// `fetchFn` and drive these modules directly under the node test runner.

import type { RelayEvent } from "@/shared/api/types";

// NOTE: relative runtime imports carry the explicit `.ts` extension so the
// node test runner (contract tests) resolves them; `allowImportingTsExtensions`
// + the bundler accept it everywhere else.
import { getSigner } from "../index.ts";
import type { PlatformSigner, SignEventInput } from "../types";
import {
  DIRECTORY_PAGE_SIZE,
  KIND_HTTP_AUTH,
  MAX_CONTENT_BYTES,
} from "./kinds.ts";

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

/** Untyped invoke args, narrowed per command inside each handler. */
export type Args = Record<string, unknown>;

/** One command handler in a domain dispatch map. */
export type Handler = (args: Args) => unknown | Promise<unknown>;

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
export function relayHttpToWsUrl(httpUrl: string): string {
  const trimmed = httpUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice(8)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice(7)}`;
  return trimmed;
}

function sameOriginWsUrl(): string | null {
  if (typeof window === "undefined" || !window.location) return null;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/teams/relay`;
}

function envRelayUrl(): string | null {
  const url = import.meta.env?.VITE_RELAY_URL;
  return typeof url === "string" && url.length > 0 ? url : null;
}

/**
 * Default relay WS URL — no workspace override (get_default_relay_url).
 * Falls back to same-origin when the web bundle is served by the relay.
 */
export function defaultRelayWsUrl(): string {
  const url = envRelayUrl() ?? sameOriginWsUrl();
  if (!url) {
    throw new Error(
      "no relay URL configured: add a workspace or set VITE_RELAY_URL",
    );
  }
  return url;
}

/** Active workspace relay WS URL, or null when none is configured. */
export function activeWorkspaceRelayWsUrl(): string | null {
  return workspaceRelayWsUrl();
}

// ── Crypto / encoding helpers ────────────────────────────────────────────────

const textEncoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
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

export function firstTagValue(
  event: RelayEvent,
  name: string,
): string | undefined {
  const tag = event.tags.find((t) => t[0] === name);
  return tag?.[1];
}

export function hasTag(event: RelayEvent, name: string): boolean {
  return event.tags.some((t) => t[0] === name);
}

/** Rust `timestamp_to_iso`: RFC-3339 without millis (`YYYY-MM-DDTHH:MM:SSZ`). */
export function timestampToIso(secs: number): string {
  return `${new Date(secs * 1000).toISOString().slice(0, 19)}Z`;
}

// ── Event validation (ports of src-tauri/src/events.rs) ─────────────────────

export function checkContent(content: string): void {
  const bytes = textEncoder.encode(content).length;
  if (bytes > MAX_CONTENT_BYTES) {
    throw new Error(
      `content exceeds maximum size of ${MAX_CONTENT_BYTES} bytes (got ${bytes})`,
    );
  }
}

export function checkPubkey(pubkey: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    throw new Error(
      `pubkey must be a 64-character hex string (got ${pubkey.length} chars)`,
    );
  }
}

export function checkEventId(eventId: string, what: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(eventId)) {
    throw new Error(`invalid ${what}: ${eventId}`);
  }
}

export function parseChannelUuid(channelId: string): string {
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

// ── Relay context ────────────────────────────────────────────────────────────

export type SubmitEventResponse = {
  event_id: string;
  accepted: boolean;
  message: string;
};

export type RelayContext = {
  options: BrowserCommandsOptions;
  signer: PlatformSigner;
  /** Relay HTTP base URL, resolved per call (workspace switches apply). */
  baseUrl(): string;
  /** Mirror of `query_relay`. */
  relayQuery(filters: Array<Record<string, unknown>>): Promise<RelayEvent[]>;
  /** Best-effort query: Rust uses `.unwrap_or_default()` in several places. */
  relayQueryOrEmpty(
    filters: Array<Record<string, unknown>>,
  ): Promise<RelayEvent[]>;
  /** Mirror of `query_relay_all` (composite until/before_id paging). */
  relayQueryAll(filter: Record<string, unknown>): Promise<RelayEvent[]>;
  /** Mirror of `submit_event`: sign via the platform signer, POST /events. */
  submitEvent(input: SignEventInput): Promise<SubmitEventResponse>;
  /** Mirror of `parse_command_response` ("response:{json}" or raw JSON). */
  parseCommandResponse<T>(message: string): T;
  myPubkey(): Promise<string>;
};

export function createRelayContext(
  options: BrowserCommandsOptions = {},
): RelayContext {
  const signer = options.signer ?? getSigner();
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);

  /** Relay HTTP base URL, resolved per call (workspace switches apply). */
  function baseUrl(): string {
    if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
    const wsUrl = workspaceRelayWsUrl() ?? defaultRelayWsUrl();
    return relayWsToHttpBase(wsUrl);
  }

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

  function relayQuery(
    filters: Array<Record<string, unknown>>,
  ): Promise<RelayEvent[]> {
    return relayPost<RelayEvent[]>("/query", JSON.stringify(filters));
  }

  async function relayQueryOrEmpty(
    filters: Array<Record<string, unknown>>,
  ): Promise<RelayEvent[]> {
    try {
      return await relayQuery(filters);
    } catch {
      return [];
    }
  }

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

  async function myPubkey(): Promise<string> {
    return signer.getPublicKey();
  }

  return {
    options,
    signer,
    baseUrl,
    relayQuery,
    relayQueryOrEmpty,
    relayQueryAll,
    submitEvent,
    parseCommandResponse,
    myPubkey,
  };
}
