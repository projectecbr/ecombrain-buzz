import { getPlatform, getSigner } from "@/platform";
import { invokeTauri } from "@/shared/api/tauri";
import type { Identity } from "@/shared/api/types";
import { truncatePubkey } from "@/shared/lib/pubkey";

type RawIdentity = {
  pubkey: string;
  display_name: string;
  lost?: boolean;
  locked?: boolean;
};

function fromRawIdentity(raw: RawIdentity): Identity {
  return {
    pubkey: raw.pubkey,
    displayName: raw.display_name,
    lost: raw.lost === true,
    locked: raw.locked === true,
  };
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
    displayName: truncatePubkey(pubkey),
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
