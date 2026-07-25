// Platform adapter seam types for the Buzz-Web browser port (Phase 2).
//
// Every Tauri touchpoint in the app collapses into one of these four
// interfaces. The desktop build wires them to the existing Tauri paths; the
// web build (import.meta.env.VITE_PLATFORM === "web") wires browser
// implementations. App code must never import `@tauri-apps/*` directly once
// its seam is ported — it goes through `platform/index.ts`.
//
// These types intentionally avoid importing from `shared/api/tauri.ts`: that
// module imports `@tauri-apps/api` and would drag Tauri back into the web
// bundle. `RelayEvent` comes from the Tauri-free `shared/api/types.ts`.

import type { RelayEvent } from "@/shared/api/types";

/** Opaque connection handle returned by `PlatformTransport.connect`. */
export type TransportHandle = {
  /** Connection id, matching the `plugin:websocket` numeric id on Tauri. */
  id: number;
};

/**
 * Inbound message from the transport.
 *
 * Text frames are delivered as plain strings (matching the plugin's
 * `{ type: "Text", data }` payload, which `getTextPayload` also accepts as a
 * bare string). Socket lifecycle events mirror the plugin's control frames so
 * `relayClientSession`'s Close/Error reconnect handling works unchanged on
 * both platforms.
 */
export type TransportMessage =
  | string
  | { type: "Close"; data: unknown }
  | { type: "Error"; data: unknown };

/**
 * Adapter A — relay WebSocket transport.
 *
 * Mirrors the `plugin:websocket` seam in `shared/api/relayClientSession.ts`:
 * connect returns a handle once the socket is open and delivers inbound
 * frames to `onMessage`; `send` transmits one text frame; `close` tears down.
 * Implementations map browser `WebSocket` events onto the same shapes the
 * Tauri plugin produced so `relayClientSession` logic stays untouched.
 */
export interface PlatformTransport {
  connect(
    url: string,
    onMessage: (handle: TransportHandle, message: TransportMessage) => void,
  ): Promise<TransportHandle>;
  /**
   * Send one text frame. The Tauri adapter returns the plugin `invoke`
   * promise (rejections drive the reconnect path in `sendRaw`); the browser
   * adapter sends synchronously and throws on a dead socket, which `await`
   * turns into the same rejection.
   */
  send(handle: TransportHandle, frame: string): void | Promise<void>;
  /** Tear down the socket with a WebSocket 1000 close frame. */
  close(handle: TransportHandle, reason?: string): void;
}

/** Unsigned event input, mirroring the Rust `sign_event` command input. */
export type SignEventInput = {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
};

/**
 * Adapter B — identity & signing.
 *
 * Replaces the Rust keyring-backed `sign_event` / identity commands. The web
 * implementation never holds a long-lived private key in the browser beyond
 * the dev-only localkey signer (Phase 4 swaps in the NIP-46 bunker).
 */
export interface PlatformSigner {
  /** Hex public key of the active identity. */
  getPublicKey(): Promise<string>;
  signEvent(input: SignEventInput): Promise<RelayEvent>;
}

/**
 * Adapter C — the `invokeTauri` command surface (`shared/api/tauri.ts:305`).
 *
 * Tauri: passthrough to `invoke`. Web: NIP-98-signed REST against the relay
 * HTTP bridge (`/query`, `/events`, `/count`, media endpoints), returning the
 * same shapes the Rust commands return today.
 */
export interface PlatformCommands {
  call<T>(command: string, args?: unknown): Promise<T>;
}

/**
 * Uploaded media descriptor. Mirrors `BlobDescriptor` in
 * `shared/api/tauri.ts` (kept structurally identical; duplicated here so the
 * platform layer does not import the Tauri-coupled module).
 */
export type UploadResult = {
  url: string;
  sha256: string;
  size: number;
  type: string;
  uploaded: number;
  dim?: string;
  blurhash?: string;
  thumb?: string;
  duration?: number;
  image?: string;
  /** Original filename captured client-side. */
  filename?: string;
};

/**
 * Media seam — serving, upload, download, clipboard.
 *
 * Tauri: Rust localhost media proxy + native file picker + shell download.
 * Web: relay HTTP URLs directly (Blossom), `<input type=file>` + Blossom PUT,
 * `<a download>`, and `navigator.clipboard`.
 */
export interface PlatformMedia {
  /** Resolve a media path/blob id to a fetchable URL. */
  resolveUrl(path: string): string;
  /**
   * Let the user pick files and upload them. Returns one descriptor per
   * picked file, matching `pick_and_upload_media` (`BlobDescriptor[]`).
   */
  pickAndUpload(): Promise<UploadResult[]>;
  /** Save a remote file locally (browser: `<a download>`). */
  download(url: string, filename: string): void;
  /** Copy an image to the system clipboard. */
  copyImage(url: string): Promise<void>;
}
