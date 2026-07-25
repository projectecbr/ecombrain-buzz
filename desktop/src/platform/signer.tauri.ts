// Adapter B (tauri) — PlatformSigner over the existing Rust identity commands.
//
// Zero behavior change: `signEvent` invokes the same `sign_event` command
// `signRelayEvent` (shared/api/tauri.ts) used before the seam, passing the
// identical camelCase arg shape (Tauri maps `createdAt` → the Rust
// `created_at` param), and JSON.parses the returned event string.
// `getPublicKey` reads the pubkey out of `get_identity` — the same command
// behind `tauriIdentity.getIdentity()`.

import { invoke } from "@tauri-apps/api/core";

import type { RelayEvent } from "@/shared/api/types";

import type { PlatformSigner } from "./types";

export type TauriSignerOptions = {
  /** Test seam: inject a fake invoke. Defaults to the real Tauri invoke. */
  invokeFn?: typeof invoke;
};

export function createTauriSigner(
  options: TauriSignerOptions = {},
): PlatformSigner {
  const invokeFn = options.invokeFn ?? invoke;

  return {
    async getPublicKey() {
      const identity = await invokeFn<{ pubkey: string }>("get_identity");
      return identity.pubkey;
    },

    async signEvent(input): Promise<RelayEvent> {
      const eventJson = await invokeFn<string>("sign_event", {
        kind: input.kind,
        content: input.content,
        createdAt: input.created_at,
        tags: input.tags,
      });
      return JSON.parse(eventJson) as RelayEvent;
    },
  };
}
