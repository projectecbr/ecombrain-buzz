// Adapter B (web, Phase 4) — NIP-46 bunker signer STUB.
//
// Phase 4 wires the real remote-signer flow on top of nostr-tools
// `BunkerSigner`: parse the `bunker://...?relay=...` URI, connect, and
// delegate getPublicKey/signEvent over NIP-46. Until then this stub
// satisfies the PlatformSigner shape so call sites compile against the final
// interface, and every method fails loudly instead of silently falling back
// to a local key.
//
// Intentionally NOT exported from platform/index.ts: keeping it out of the
// factory keeps it out of both bundles until Phase 4 wires it.

import type { PlatformSigner } from "./types";

const UNAVAILABLE = "PHASE-4: bunker not available";

export function createBunkerSigner(bunkerUri: string): PlatformSigner {
  // Retained for Phase 4 (BunkerSigner.fromURI); unused today.
  void bunkerUri;

  return {
    getPublicKey() {
      throw new Error(UNAVAILABLE);
    },
    signEvent() {
      throw new Error(UNAVAILABLE);
    },
  };
}
