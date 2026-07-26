// Production browser signer. The browser keeps only an ephemeral NIP-46
// client key; the custodial signing key remains in EcomBrain's backend.

import { generateSecretKey, getPublicKey } from "nostr-tools";
import { BunkerSigner, type BunkerPointer } from "nostr-tools/nip46";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";

import type { RelayEvent } from "@/shared/api/types";

import type { PlatformSigner, SignEventInput } from "./types";
import { clearRelayBinding, saveRelayBinding } from "./relay-auth-url";

export const BUNKER_SESSION_KEY = "ecombrain-teams-bunker-v1";
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const CONNECTION_SECRET = /^[A-Za-z0-9_-]{43}$/;
const REQUEST_TIMEOUT_MS = 15_000;

type BunkerClient = {
  connect(metadata?: { name?: string; url?: string }): Promise<void>;
  getPublicKey(): Promise<string>;
  signEvent(event: Required<SignEventInput>): Promise<RelayEvent>;
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>;
  close?(): Promise<void>;
};

type StoredBunkerSession = {
  clientSecret: string;
  identityPubkey: string;
  expiresAt: number;
  relayUrl: string;
  relayAuthUrl: string;
  bunker: BunkerPointer;
};

type BunkerSignerOptions = {
  fetchFn?: typeof fetch;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  createClient?: (
    clientSecret: Uint8Array,
    pointer: BunkerPointer,
  ) => BunkerClient;
};

let cachedClient: Promise<BunkerClient> | null = null;

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function validPointer(value: unknown): value is BunkerPointer {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Partial<BunkerPointer>;
  return (
    typeof pointer.pubkey === "string" &&
    HEX_PUBKEY.test(pointer.pubkey) &&
    Array.isArray(pointer.relays) &&
    pointer.relays.length > 0 &&
    pointer.relays.every((relay) => {
      if (typeof relay !== "string") return false;
      try {
        const protocol = new URL(relay).protocol;
        return (
          protocol === "wss:" ||
          (protocol === "ws:" &&
            (location.hostname === "localhost" ||
              location.hostname === "127.0.0.1"))
        );
      } catch {
        return false;
      }
    }) &&
    typeof pointer.secret === "string" &&
    CONNECTION_SECRET.test(pointer.secret)
  );
}

function parseStoredSession(value: string | null): StoredBunkerSession | null {
  try {
    const session = JSON.parse(value ?? "null") as Partial<StoredBunkerSession>;
    return session &&
      typeof session.clientSecret === "string" &&
      HEX_PUBKEY.test(session.clientSecret) &&
      typeof session.identityPubkey === "string" &&
      HEX_PUBKEY.test(session.identityPubkey) &&
      typeof session.expiresAt === "number" &&
      session.expiresAt > Date.now() &&
      typeof session.relayUrl === "string" &&
      validRelayUrl(session.relayUrl) &&
      typeof session.relayAuthUrl === "string" &&
      validRelayUrl(session.relayAuthUrl) &&
      validPointer(session.bunker)
      ? (session as StoredBunkerSession)
      : null;
  } catch {
    return null;
  }
}

function validRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" || url.protocol === "ws:";
  } catch {
    return false;
  }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Teams signer request timed out")),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function issueBinding(
  fetchFn: typeof fetch,
  storage: BunkerSignerOptions["storage"],
): Promise<StoredBunkerSession> {
  const clientSecret = generateSecretKey();
  try {
    const response = await fetchFn("/teams/api/session-bind", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientPubkey: getPublicKey(clientSecret) }),
    });
    if (!response.ok) {
      throw new Error(
        response.status === 409
          ? "This Teams session is already open; reopen Teams from EcomBrain"
          : `Teams signer setup failed (${response.status})`,
      );
    }
    const payload = (await response.json()) as Partial<StoredBunkerSession>;
    const session: StoredBunkerSession = {
      clientSecret: bytesToHex(clientSecret),
      identityPubkey: payload.identityPubkey ?? "",
      expiresAt: payload.expiresAt ?? 0,
      relayUrl: payload.relayUrl ?? "",
      relayAuthUrl: payload.relayAuthUrl ?? "",
      bunker: payload.bunker as BunkerPointer,
    };
    if (!parseStoredSession(JSON.stringify(session))) {
      throw new Error("Teams signer setup returned an invalid binding");
    }
    storage?.setItem(BUNKER_SESSION_KEY, JSON.stringify(session));
    saveRelayBinding(
      {
        transportUrl: session.relayUrl,
        authUrl: session.relayAuthUrl,
        expiresAt: session.expiresAt,
      },
      storage,
    );
    return session;
  } finally {
    clientSecret.fill(0);
  }
}

async function loadClient(options: BunkerSignerOptions): Promise<BunkerClient> {
  const storage =
    options.storage === undefined ? safeSessionStorage() : options.storage;
  let session = parseStoredSession(
    storage?.getItem(BUNKER_SESSION_KEY) ?? null,
  );
  if (!session) {
    storage?.removeItem(BUNKER_SESSION_KEY);
    clearRelayBinding(storage);
    session = await issueBinding(
      options.fetchFn ?? globalThis.fetch.bind(globalThis),
      storage,
    );
  }
  const clientSecret = hexToBytes(session.clientSecret);
  const createClient =
    options.createClient ??
    ((secret: Uint8Array, pointer: BunkerPointer) =>
      BunkerSigner.fromBunker(secret, pointer) as BunkerClient);
  const client = createClient(clientSecret, session.bunker);
  try {
    await withTimeout(client.connect({ name: "EcomBrain Teams" }));
    if ((await withTimeout(client.getPublicKey())) !== session.identityPubkey) {
      throw new Error("Teams signer identity does not match the bound session");
    }
    return client;
  } catch (error) {
    await client.close?.().catch(() => undefined);
    storage?.removeItem(BUNKER_SESSION_KEY);
    clearRelayBinding(storage);
    throw error;
  } finally {
    clientSecret.fill(0);
  }
}

export function __resetBunkerSignerForTests(): void {
  cachedClient = null;
}

export function createBunkerSigner(
  options: BunkerSignerOptions = {},
): PlatformSigner {
  const client = () => (cachedClient ??= loadClient(options));
  return {
    async getPublicKey() {
      return withTimeout((await client()).getPublicKey());
    },
    async signEvent(input) {
      return withTimeout(
        (await client()).signEvent({
          ...input,
          created_at: input.created_at ?? Math.floor(Date.now() / 1000),
        }),
      );
    },
    async encryptToSelf(plaintext) {
      const signer = await client();
      return withTimeout(
        signer
          .getPublicKey()
          .then((pubkey) => signer.nip44Encrypt(pubkey, plaintext)),
      );
    },
    async decryptFromSelf(ciphertext) {
      const signer = await client();
      return withTimeout(
        signer
          .getPublicKey()
          .then((pubkey) => signer.nip44Decrypt(pubkey, ciphertext)),
      );
    },
  };
}
