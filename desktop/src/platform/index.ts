// Platform adapter entrypoint (Phase 2 — Buzz-Web port).
//
// `getPlatform()` selects the active runtime: "web" for the browser bundle
// (vite.web.config.ts defines `import.meta.env.VITE_PLATFORM = "web"`),
// "tauri" for the desktop app. The four factories return the adapter for the
// active platform; they are lazy so importing this module never pulls a
// platform implementation into the wrong bundle graph.
//
// Tasks 2–4 wire the real implementations (browser WebSocket transport,
// nostr-tools/NIP-46 signer, NIP-98 REST commands, browser media). Until
// then every factory throws `not wired yet`.

import type {
  PlatformCommands,
  PlatformMedia,
  PlatformSigner,
  PlatformTransport,
} from "./types";

export type PlatformKind = "tauri" | "web";

export type {
  PlatformCommands,
  PlatformMedia,
  PlatformSigner,
  PlatformTransport,
  SignEventInput,
  TransportHandle,
  UploadResult,
} from "./types";

// Test seam: the node test runner has no `import.meta.env`, so tests force
// the platform through this override instead of the Vite define.
let platformOverride: PlatformKind | null = null;

/** @internal Test-only: force the platform (pass null to clear). */
export function __setPlatformOverrideForTests(
  platform: PlatformKind | null,
): void {
  platformOverride = platform;
}

export function getPlatform(): PlatformKind {
  if (platformOverride !== null) return platformOverride;
  // `import.meta.env` is undefined under the bare node test runner; the `?.`
  // keeps that path returning "tauri" instead of throwing.
  return import.meta.env?.VITE_PLATFORM === "web" ? "web" : "tauri";
}

function notWired(adapter: string): never {
  throw new Error(
    `platform adapter "${adapter}" is not wired yet (platform: ${getPlatform()})`,
  );
}

/** Adapter A — relay WebSocket transport. Wired in Task 2. */
export function getTransport(): PlatformTransport {
  return notWired("transport");
}

/** Adapter B — identity & signing. Wired in Task 3. */
export function getSigner(): PlatformSigner {
  return notWired("signer");
}

/** Adapter C — invoke command surface. Wired in Task 4. */
export function getCommands(): PlatformCommands {
  return notWired("commands");
}

/** Media seam — upload/download/clipboard/URL resolution. Wired in Task 4. */
export function getMedia(): PlatformMedia {
  return notWired("media");
}
