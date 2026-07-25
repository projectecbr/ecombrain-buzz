import { nip19 } from "nostr-tools";

import { getPlatform, getSigner } from "@/platform";
import { invokeTauri } from "@/shared/api/tauri";
import type { Identity } from "@/shared/api/types";

type RawIdentity = {
  pubkey: string;
  display_name: string;
  lost?: boolean;
  locked?: boolean;
  reset_failed?: boolean;
};

function fromRawIdentity(raw: RawIdentity): Identity {
  return {
    pubkey: raw.pubkey,
    displayName: raw.display_name,
    lost: raw.lost === true,
    locked: raw.locked === true,
    resetFailed: raw.reset_failed === true,
  };
}

/** Mirrors the Rust `truncated_display_name`: npub, first 10 + "…" + last 4. */
function truncatedDisplayName(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey);
    return npub.length > 16 ? `${npub.slice(0, 10)}…${npub.slice(-4)}` : npub;
  } catch {
    return `${pubkey.slice(0, 10)}…${pubkey.slice(-4)}`;
  }
}

/**
 * Web identity: the DEV-ONLY localkey signer's pubkey, shaped exactly like
 * the Rust `get_identity` result (never lost, never locked — there is no OS
 * keyring in the browser). Phase 4 swaps the backing signer for NIP-46.
 */
async function getWebDevIdentity(): Promise<Identity> {
  const pubkey = await getSigner().getPublicKey();
  return {
    pubkey,
    displayName: truncatedDisplayName(pubkey),
    lost: false,
    locked: false,
  };
}

export async function getIdentity(): Promise<Identity> {
  if (getPlatform() === "web") {
    return getWebDevIdentity();
  }
  return fromRawIdentity(await invokeTauri<RawIdentity>("get_identity"));
}

export async function getNsec(): Promise<string> {
  if (getPlatform() === "web") {
    throw new Error(
      "get_nsec is unavailable on web: private keys never leave the DEV-ONLY localkey signer (Phase 4 replaces it with the NIP-46 bunker)",
    );
  }
  return invokeTauri<string>("get_nsec");
}

export async function importIdentity(nsec: string): Promise<Identity> {
  if (getPlatform() === "web") {
    console.info(
      "[identity] importIdentity is a no-op on web — the DEV-ONLY localkey identity stays active (Phase 4: NIP-46 bunker)",
    );
    return getWebDevIdentity();
  }
  return fromRawIdentity(
    await invokeTauri<RawIdentity>("import_identity", { nsec }),
  );
}

export async function persistCurrentIdentity(): Promise<Identity> {
  if (getPlatform() === "web") {
    console.info(
      "[identity] persistCurrentIdentity is a no-op on web — the DEV-ONLY localkey identity is already persisted to sessionStorage",
    );
    return getWebDevIdentity();
  }
  return fromRawIdentity(
    await invokeTauri<RawIdentity>("persist_current_identity"),
  );
}

/**
 * Wipe all local Buzz state (keychain, App Support, WebKit, nest, OAuth cache,
 * CLI symlinks) and relaunch into first-run onboarding.
 *
 * The app restarts after this call completes. Callers should keep the pending
 * state until the process exits and only handle errors (e.g. display a toast).
 */
export async function signOut(): Promise<void> {
  await invokeTauri("sign_out");
}
