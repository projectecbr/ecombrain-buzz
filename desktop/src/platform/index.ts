// Platform adapter entrypoint (Phase 2 — Buzz-Web port).
//
// `getPlatform()` selects the active runtime: "web" for the browser bundle
// (vite.web.config.ts defines `import.meta.env.VITE_PLATFORM = "web"`),
// "tauri" for the desktop app. The four factories return the adapter for the
// active platform; they are lazy so importing this module never pulls a
// platform implementation into the wrong bundle graph.
//
// Tasks 2–4 wire the real implementations (browser WebSocket transport,
// nostr-tools/NIP-46 signer, NIP-98 REST commands, browser media). The
// media factory is the last one still throwing `not wired yet`.

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
  TransportMessage,
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
//
// Lazy sync accessor: the real adapter is loaded via dynamic import behind a
// cached promise, so importing this module never pulls an implementation into
// the wrong bundle graph. The branch reads `import.meta.env.VITE_PLATFORM`
// directly (not getPlatform()) so the web build's define lets the minifier
// fold the tauri branch away — `plugin:websocket` never reaches dist-web, and
// the browser shim never reaches the desktop bundle. Correctness of the lazy
// proxy relies on connect() always preceding send()/close(), which is how
// both relay clients already drive the transport.
let transportImplPromise: Promise<PlatformTransport> | null = null;
let transportProxy: PlatformTransport | null = null;

function loadTransportImpl(): Promise<PlatformTransport> {
  if (!transportImplPromise) {
    transportImplPromise =
      import.meta.env?.VITE_PLATFORM === "web"
        ? import("./transport.browser").then((m) => m.createBrowserTransport())
        : import("./transport.tauri").then((m) => m.createTauriTransport());
  }
  return transportImplPromise;
}

export function getTransport(): PlatformTransport {
  if (!transportProxy) {
    transportProxy = {
      connect: (url, onMessage) =>
        loadTransportImpl().then((impl) => impl.connect(url, onMessage)),
      send: (handle, frame) =>
        loadTransportImpl().then((impl) => impl.send(handle, frame)),
      close: (handle, reason) => {
        void loadTransportImpl().then((impl) => impl.close(handle, reason));
      },
    };
  }
  return transportProxy;
}

/** Adapter B — identity & signing. Wired in Task 3. */
//
// Same lazy sync-proxy pattern as getTransport() above: the static
// `import.meta.env.VITE_PLATFORM` branch lets the minifier drop the tauri
// chunk (with its `sign_event` invoke) from dist-web and the localkey dev
// signer from the desktop bundle. signer.bunker.ts (Phase 4, NIP-46) is
// deliberately not referenced here so it stays out of both bundles.
let signerImplPromise: Promise<PlatformSigner> | null = null;
let signerProxy: PlatformSigner | null = null;

function loadSignerImpl(): Promise<PlatformSigner> {
  if (!signerImplPromise) {
    signerImplPromise =
      import.meta.env?.VITE_PLATFORM === "web"
        ? import("./signer.localkey").then((m) => m.createLocalKeySigner())
        : import("./signer.tauri").then((m) => m.createTauriSigner());
  }
  return signerImplPromise;
}

export function getSigner(): PlatformSigner {
  if (!signerProxy) {
    signerProxy = {
      getPublicKey: () => loadSignerImpl().then((impl) => impl.getPublicKey()),
      signEvent: (input) =>
        loadSignerImpl().then((impl) => impl.signEvent(input)),
    };
  }
  return signerProxy;
}

/** Adapter C — invoke command surface. Wired in Task 4.
 *
 * Same lazy sync-proxy pattern as getTransport()/getSigner() above: the
 * static `import.meta.env.VITE_PLATFORM` branch lets the minifier drop
 * commands.tauri (with its `@tauri-apps/api` invoke) from dist-web and the
 * NIP-98 REST implementation from the desktop bundle. `invokeTauri`
 * (tauri.ts) delegates here, so every `tauri*.ts` proxy routes through this
 * seam with no call-site changes. */
let commandsImplPromise: Promise<PlatformCommands> | null = null;
let commandsProxy: PlatformCommands | null = null;

function loadCommandsImpl(): Promise<PlatformCommands> {
  if (!commandsImplPromise) {
    commandsImplPromise =
      import.meta.env?.VITE_PLATFORM === "web"
        ? import("./commands.browser").then((m) => m.createBrowserCommands())
        : import("./commands.tauri").then((m) => m.createTauriCommands());
  }
  return commandsImplPromise;
}

export function getCommands(): PlatformCommands {
  if (!commandsProxy) {
    commandsProxy = {
      call: <T>(command: string, args?: unknown): Promise<T> =>
        loadCommandsImpl().then((impl) => impl.call<T>(command, args)),
    };
  }
  return commandsProxy;
}

/** Media seam — upload/download/clipboard/URL resolution. Wired in Task 4. */
export function getMedia(): PlatformMedia {
  return notWired("media");
}
