import type { RelayEvent } from "@/shared/api/types";

import {
  type Args,
  checkContent,
  checkPubkey,
  type RelayContext,
} from "./context.ts";

type ProfileJson = Record<string, unknown>;

function profileJson(event: RelayEvent | undefined): ProfileJson {
  if (!event) return {};
  try {
    const value = JSON.parse(event.content) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as ProfileJson)
      : {};
  } catch {
    return {};
  }
}

function stringField(value: ProfileJson, key: string): string | null {
  return typeof value[key] === "string" ? value[key] : null;
}

function rawProfile(event: RelayEvent | undefined, pubkey: string) {
  const content = profileJson(event);
  return {
    pubkey,
    display_name:
      stringField(content, "display_name") ?? stringField(content, "name"),
    avatar_url: stringField(content, "picture"),
    about: stringField(content, "about"),
    nip05_handle: stringField(content, "nip05"),
    // Browser Teams never trusts an unverified NIP-OA auth tag. Agent status
    // comes from signed kind:10100 profiles and channel membership roles.
    owner_pubkey: null,
    has_profile_event: Boolean(event),
  };
}

function rawSummary(event: RelayEvent) {
  const content = profileJson(event);
  return {
    display_name:
      stringField(content, "display_name") ?? stringField(content, "name"),
    name: stringField(content, "name"),
    avatar_url: stringField(content, "picture"),
    nip05_handle: stringField(content, "nip05"),
    owner_pubkey: null,
    is_agent: false,
  };
}

function latestByAuthor(events: RelayEvent[]): Map<string, RelayEvent> {
  const latest = new Map<string, RelayEvent>();
  for (const event of events) {
    const key = event.pubkey.toLowerCase();
    const prior = latest.get(key);
    if (!prior || event.created_at > prior.created_at) latest.set(key, event);
  }
  return latest;
}

function searchScore(query: string, event: RelayEvent): number {
  const content = profileJson(event);
  const display = (
    stringField(content, "display_name") ??
    stringField(content, "name") ??
    ""
  ).toLowerCase();
  const nip05 = (stringField(content, "nip05") ?? "").toLowerCase();
  const pubkey = event.pubkey.toLowerCase();
  const score = (value: string, exact: number, prefix: number, part: number) =>
    value === query
      ? exact
      : value.startsWith(query)
        ? prefix
        : value.includes(query)
          ? part
          : 0;
  return Math.max(
    score(display, 1_000, 900, 800),
    score(nip05, 700, 600, 500),
    pubkey.startsWith(query) ? 400 : 0,
  );
}

export function profileHandlers(
  ctx: RelayContext,
): Record<string, (args: Args) => unknown | Promise<unknown>> {
  const { myPubkey, relayQuery, relayQueryOrEmpty, submitEvent } = ctx;

  async function readProfile(pubkey: string) {
    checkPubkey(pubkey);
    const events = await relayQuery([
      { kinds: [0], authors: [pubkey], limit: 1 },
    ]);
    return rawProfile(events[0], pubkey);
  }

  async function getUsersBatch(args: Args) {
    const requested = (args.pubkeys as string[]).map((value) =>
      value.toLowerCase(),
    );
    if (requested.length === 0) return { profiles: {}, missing: [] };
    for (const pubkey of requested) checkPubkey(pubkey);
    const events = await relayQuery([{ kinds: [0], authors: requested }]);
    const latest = latestByAuthor(events);
    return {
      profiles: Object.fromEntries(
        [...latest].map(([pubkey, event]) => [pubkey, rawSummary(event)]),
      ),
      missing: requested.filter((pubkey) => !latest.has(pubkey)),
    };
  }

  async function searchUsers(args: Args) {
    const query = (args.query as string).trim().toLowerCase();
    const limit = Math.min((args.limit as number | undefined) ?? 8, 500);
    const page = Math.max(
      Number.parseInt((args.cursor as string) || "1", 10) || 1,
      1,
    );
    if (limit === 0) return { users: [], next_cursor: null };
    const filter: Record<string, unknown> = {
      kinds: [0],
      limit,
      page,
    };
    if (query) {
      filter.search = query;
      filter.search_mode = "prefix";
    }
    const events = await relayQuery([filter]);
    const latest = [...latestByAuthor(events).values()];
    if (query) {
      latest.sort(
        (left, right) => searchScore(query, right) - searchScore(query, left),
      );
    } else {
      latest.sort((left, right) => {
        const leftName =
          rawProfile(left, left.pubkey).display_name ?? left.pubkey;
        const rightName =
          rawProfile(right, right.pubkey).display_name ?? right.pubkey;
        return (
          leftName.localeCompare(rightName) ||
          left.pubkey.localeCompare(right.pubkey)
        );
      });
    }
    return {
      users: latest.slice(0, limit).map((event) => ({
        pubkey: event.pubkey,
        ...rawSummary(event),
      })),
      next_cursor: events.length >= limit ? String(page + 1) : null,
    };
  }

  async function updateProfile(args: Args) {
    const pubkey = await myPubkey();
    const prior = await relayQueryOrEmpty([
      { kinds: [0], authors: [pubkey], limit: 1 },
    ]);
    const current = profileJson(prior[0]);
    const content = JSON.stringify({
      display_name:
        (args.displayName as string | null | undefined) ??
        stringField(current, "display_name"),
      name: stringField(current, "name"),
      picture:
        (args.avatarUrl as string | null | undefined) ??
        stringField(current, "picture"),
      about:
        (args.about as string | null | undefined) ??
        stringField(current, "about"),
      nip05:
        (args.nip05Handle as string | null | undefined) ??
        stringField(current, "nip05"),
    });
    checkContent(content);
    await submitEvent({ kind: 0, content, tags: [] });
    const events = await relayQuery([
      { kinds: [0], authors: [pubkey], limit: 1 },
    ]);
    return rawProfile(events[0], pubkey);
  }

  async function getPresence(args: Args) {
    const pubkeys = (args.pubkeys as string[]).map((value) =>
      value.toLowerCase(),
    );
    if (pubkeys.length === 0) return {};
    for (const pubkey of pubkeys) checkPubkey(pubkey);
    const events = await relayQueryOrEmpty([
      { kinds: [20001], authors: pubkeys },
    ]);
    const latest = new Map<string, { createdAt: number; status: string }>();
    for (const event of events) {
      const status = event.content.trim();
      if (!["online", "away", "offline"].includes(status)) continue;
      const subject =
        event.tags.find((tag) => tag[0] === "p")?.[1]?.toLowerCase() ??
        event.pubkey.toLowerCase();
      const prior = latest.get(subject);
      if (!prior || event.created_at > prior.createdAt) {
        latest.set(subject, { createdAt: event.created_at, status });
      }
    }
    return Object.fromEntries(
      [...latest].map(([pubkey, value]) => [pubkey, value.status]),
    );
  }

  return {
    get_profile: async () => readProfile(await myPubkey()),
    get_user_profile: async (args) =>
      readProfile(
        (args.pubkey as string | null | undefined) ?? (await myPubkey()),
      ),
    get_users_batch: getUsersBatch,
    search_users: searchUsers,
    update_profile: updateProfile,
    get_presence: getPresence,
  };
}
