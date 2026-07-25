// Adapter B (web) — PlatformSigner over a locally generated nostr key.
//
// DEV-ONLY: the secret key lives in module memory and is persisted to
// sessionStorage under "ecombrain-teams-dev-identity" (deliberately NOT a
// `buzz-*` key) so a tab keeps one identity for its lifetime. Phase 4
// replaces this with the NIP-46 bunker signer (see signer.bunker.ts) —
// private keys must never live in the browser beyond this dev signer.
//
// Node-compatible: sessionStorage is absent under the node test runner, so
// the signer falls back to module memory only (the contract test in
// ecombrain/contract-tests drives this file directly).

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

import type { PlatformSigner } from "./types";

/** sessionStorage key for the DEV-ONLY browser identity. */
export const LOCALKEY_STORAGE_KEY = "ecombrain-teams-dev-identity";

// Module memory: one identity per JS realm, shared across signer instances
// so getPublicKey() is deterministic no matter who asks.
let cachedSecretKey: Uint8Array | null = null;

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    // Access can throw (e.g. disabled storage); treat as absent.
    return null;
  }
}

function loadSecretKey(): Uint8Array {
  if (cachedSecretKey !== null) return cachedSecretKey;

  const store = safeSessionStorage();
  const stored = store?.getItem(LOCALKEY_STORAGE_KEY) ?? null;
  if (stored !== null && /^[0-9a-f]{64}$/.test(stored)) {
    cachedSecretKey = hexToBytes(stored);
    return cachedSecretKey;
  }

  cachedSecretKey = generateSecretKey();
  try {
    store?.setItem(LOCALKEY_STORAGE_KEY, bytesToHex(cachedSecretKey));
  } catch {
    // Quota/privacy-mode failures are non-fatal: the module-memory key
    // still covers the rest of this session.
  }
  return cachedSecretKey;
}

/** @internal Test-only: drop the cached key (next call generates a fresh one). */
export function __resetLocalKeyForTests(): void {
  cachedSecretKey = null;
}

export function createLocalKeySigner(): PlatformSigner {
  return {
    getPublicKey() {
      return Promise.resolve(getPublicKey(loadSecretKey()));
    },

    signEvent(input) {
      const event = finalizeEvent(
        {
          kind: input.kind,
          content: input.content,
          tags: input.tags,
          created_at: input.created_at ?? Math.floor(Date.now() / 1000),
        },
        loadSecretKey(),
      );
      // VerifiedEvent is structurally identical to RelayEvent (id, pubkey,
      // created_at, kind, tags, content, sig).
      return Promise.resolve(event);
    },
  };
}
