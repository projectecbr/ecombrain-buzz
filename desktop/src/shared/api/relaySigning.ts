// Relay event signing entry points (Adapter B seam).
//
// Extracted from `shared/api/tauri.ts` (file-size budget) when signRelayEvent
// was rewired onto the platform signer. Re-exported from tauri.ts so all 32
// call sites keep their existing import.

import { getSigner } from "@/platform";
import { relayAuthWsUrl } from "@/platform/relay-auth-url";
import type { RelayEvent } from "@/shared/api/types";

export async function signRelayEvent(input: {
  kind: number;
  content: string;
  createdAt?: number;
  tags: string[][];
}): Promise<RelayEvent> {
  // Delegates to the platform signer seam (Adapter B): tauri resolves to the
  // same `sign_event` invoke as before, web to the localkey dev signer.
  return getSigner().signEvent({
    kind: input.kind,
    content: input.content,
    created_at: input.createdAt,
    tags: input.tags,
  });
}

export async function createAuthEvent(input: {
  challenge: string;
  relayUrl: string;
}): Promise<RelayEvent> {
  const authUrl = relayAuthWsUrl(input.relayUrl);
  // The Rust `create_auth_event` command built exactly this event (kind
  // 22242, empty content, relay + challenge tags) and signed it with the
  // same key as `sign_event` — routing it through the signer seam produces
  // an identical event on desktop and makes NIP-42 work on web unchanged.
  return signRelayEvent({
    kind: 22242,
    content: "",
    tags: [
      ["relay", authUrl],
      ["challenge", input.challenge],
    ],
  });
}
