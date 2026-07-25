export interface DeepLinkDeps {
  addWorkspace: (workspace: never) => string;
  switchWorkspace: (id: string) => void;
  reconnectWorkspace: () => void;
}

export type MessageDeepLinkPayload = {
  channelId: string;
  messageId: string;
  threadRootId: string | null;
};

export type NostrBindDeepLinkPayload = {
  challengeId: string;
  nonce: string;
  verificationCode: string;
  audience: "buzz:nostr-identity";
  action: "bind_nostr_identity";
  protocol: "buzz-nostr-identity";
  version: "1";
  origin: string;
  expiresAt: string;
  returnMode: "clipboard";
};

const noop = async () => () => undefined;

export const listenForDeepLinks = noop;
export const listenForMessageDeepLinks = noop;
export const listenForNostrBindDeepLinks = noop;
