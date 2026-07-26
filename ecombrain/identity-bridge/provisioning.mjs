import { createHash, createHmac, randomUUID } from "node:crypto";

import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools";

const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function nip98Authorization({ secret, url, method, body = "", now = Date.now() }) {
  const tags = [["u", url], ["method", method.toUpperCase()], ["nonce", randomUUID()]];
  if (body) tags.push(["payload", sha256(body)]);
  const event = finalizeEvent({ kind: 27235, content: "", tags, created_at: Math.floor(now / 1000) }, secret);
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

function scopedHeaders({ secret, prefix, audience, method, url, body = "" }) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 30;
  const requestId = randomUUID();
  const bodyHash = sha256(body);
  const parsed = new URL(url);
  const canonical = [method, `${parsed.pathname}${parsed.search}`, audience, issuedAt, expiresAt, requestId, bodyHash].join("\n");
  return {
    [`X-Teams-${prefix}-Authorization`]: `Teams-HMAC ${createHmac("sha256", secret).update(canonical).digest("hex")}`,
    [`X-Teams-${prefix}-Audience`]: audience,
    [`X-Teams-${prefix}-Issued-At`]: String(issuedAt),
    [`X-Teams-${prefix}-Expires-At`]: String(expiresAt),
    [`X-Teams-${prefix}-Request-Id`]: requestId,
    [`X-Teams-${prefix}-Body-Sha256`]: bodyHash,
  };
}

function tag(event, name) {
  const matches = event.tags.filter((item) => item[0] === name);
  return matches.length === 1 ? matches[0][1] : null;
}

function fresh(event) {
  return Number.isSafeInteger(event.created_at) &&
    Math.abs(Math.floor(Date.now() / 1000) - event.created_at) <= 120;
}

function validNip98(header, { pubkey, url, method, body }) {
  if (typeof header !== "string" || !header.startsWith("Nostr ")) return false;
  try {
    const event = JSON.parse(Buffer.from(header.slice(6), "base64").toString("utf8"));
    return verifyEvent(event) && fresh(event) && event.kind === 27235 && event.pubkey === pubkey &&
      tag(event, "u") === url && tag(event, "method") === method &&
      (!body || tag(event, "payload") === sha256(body));
  } catch {
    return false;
  }
}

function parseMembership(event) {
  const rows = [];
  const seen = new Set();
  for (const item of event.tags) {
    if (item[0] !== "member" || !HEX.test(item[1] ?? "") || seen.has(item[1])) continue;
    const role = ["owner", "admin", "member"].includes(item[2]) ? item[2] : "member";
    rows.push({ pubkey: item[1], role });
    seen.add(item[1]);
  }
  return rows;
}

export function createProvisioner(config) {
  const operatorPubkey = getPublicKey(config.operatorSecret);
  const publicBase = new URL(config.publicBase);
  const operatorOrigin = new URL(config.operatorOrigin);

  async function request(url, init) {
    const response = await config.fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return response;
  }

  async function operator(path, method, body = "") {
    const transport = new URL(`/teams/service/operator${path.slice("/operator".length)}`, publicBase);
    const canonical = new URL(path, operatorOrigin);
    const headers = {
      ...scopedHeaders({
        secret: config.operatorServiceSecret,
        prefix: "Operator",
        audience: `teams-relay-operator:${config.bunkerPubkey}`,
        method,
        url: transport,
        body,
      }),
      Authorization: nip98Authorization({ secret: config.operatorSecret, url: canonical.toString(), method, body }),
      "Content-Type": "application/json",
    };
    return request(transport, { method, headers, ...(body ? { body } : {}) });
  }

  async function relay(path, communityId, { method = "GET", body = "", authorization, headers = {} } = {}) {
    const transport = new URL(`/teams/service/relay${path}`, publicBase);
    const audience = `teams-relay-service:identity:${communityId}`;
    const derived = createHmac("sha256", config.relayServiceMasterSecret).update(audience).digest("hex");
    return request(transport, {
      method,
      headers: {
        ...headers,
        ...scopedHeaders({ secret: derived, prefix: "Relay", audience, method, url: transport, body }),
        ...(authorization ? { Authorization: authorization } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    });
  }

  async function ensureCommunity(input) {
    if (!UUID.test(input.tenantId) || !HOST.test(input.host) || !HEX.test(input.ownerPubkey)) {
      throw new Error("invalid community request");
    }
    const body = JSON.stringify({ host: input.host, initial_owner_pubkey: input.ownerPubkey, create_only: true });
    const response = await operator("/operator/communities", "POST", body);
    let result;
    if (response.status === 409) {
      const query = `?owner_pubkey=${encodeURIComponent(input.ownerPubkey)}`;
      const owned = await operator(`/operator/communities${query}`, "GET");
      if (!owned.ok) throw new Error(`operator ownership lookup failed (${owned.status})`);
      const payload = await owned.json();
      const row = payload.communities?.find((community) => community.host === input.host);
      if (!row) throw new Error("community exists under a different owner");
      result = { community_id: row.community_id, host: row.host, status: "existed", owner_pubkey: input.ownerPubkey };
    } else {
      if (!response.ok) throw new Error(`operator provision failed (${response.status})`);
      result = await response.json();
    }
    if (!UUID.test(result.community_id ?? "") || result.host !== input.host || result.owner_pubkey !== input.ownerPubkey || !["created", "existed"].includes(result.status)) {
      throw new Error("operator provision response did not match request");
    }
    return { communityId: result.community_id, host: result.host, status: result.status, ownerPubkey: result.owner_pubkey };
  }

  async function reconcileCommunity(input) {
    if (!UUID.test(input.communityId) || !HOST.test(input.host) || !HEX.test(input.ownerPubkey)) {
      throw new Error("invalid reconciliation request");
    }
    const expected = new Map([[input.ownerPubkey, "owner"]]);
    for (const member of input.members) {
      const body = JSON.stringify(member.event);
      if (!HEX.test(member.pubkey) || member.role !== "member" || expected.has(member.pubkey) ||
        !verifyEvent(member.event) || !fresh(member.event) || member.event.kind !== 9030 || member.event.pubkey !== input.ownerPubkey ||
        tag(member.event, "p") !== member.pubkey || tag(member.event, "role") !== member.role ||
        !validNip98(member.authorization, { pubkey: input.ownerPubkey, url: `https://${input.host}/events`, method: "POST", body })) {
        throw new Error("invalid membership grant");
      }
      expected.set(member.pubkey, member.role);
      const response = await relay("/events", input.communityId, { method: "POST", body, authorization: member.authorization });
      if (!response.ok) throw new Error(`membership publish failed (${response.status})`);
    }
    for (const profile of input.profiles) {
      const body = JSON.stringify(profile.event);
      if (!expected.has(profile.pubkey) || !verifyEvent(profile.event) || !fresh(profile.event) || profile.event.kind !== 0 || profile.event.pubkey !== profile.pubkey ||
        !validNip98(profile.authorization, { pubkey: profile.pubkey, url: `https://${input.host}/events`, method: "POST", body })) {
        throw new Error("invalid employee profile grant");
      }
      const response = await relay("/events", input.communityId, { method: "POST", body, authorization: profile.authorization });
      if (!response.ok) throw new Error(`employee profile publish failed (${response.status})`);
    }
    const nip11 = await relay("", input.communityId, { headers: { Accept: "application/nostr+json" } });
    const relayInfo = nip11.ok ? await nip11.json() : null;
    if (!relayInfo || !HEX.test(relayInfo.self ?? "")) throw new Error("relay NIP-11 identity is unavailable");

    if (!validNip98(input.membershipQuery.authorization, { pubkey: input.ownerPubkey, url: `https://${input.host}/query`, method: "POST", body: input.membershipQuery.body })) {
      throw new Error("invalid membership query grant");
    }
    const query = await relay("/query", input.communityId, { method: "POST", ...input.membershipQuery });
    const snapshots = query.ok ? await query.json() : [];
    const snapshot = snapshots.filter((event) => event.kind === 13534).sort((a, b) => b.created_at - a.created_at)[0];
    if (!snapshot || !verifyEvent(snapshot) || snapshot.pubkey !== relayInfo.self) {
      throw new Error("relay membership snapshot is invalid");
    }
    const actual = parseMembership(snapshot);
    const actualByPubkey = new Map(actual.map((row) => [row.pubkey, row.role]));
    const missing = [...expected].filter(([pubkey]) => !actualByPubkey.has(pubkey)).map(([pubkey, role]) => ({ pubkey, role }));
    const wrongRole = [...expected].filter(([pubkey, role]) => actualByPubkey.has(pubkey) && actualByPubkey.get(pubkey) !== role).map(([pubkey, role]) => ({ pubkey, expected: role, actual: actualByPubkey.get(pubkey) }));
    const unexpected = actual.filter((row) => !expected.has(row.pubkey));
    if (missing.length || wrongRole.length) throw new Error("relay membership did not converge");

    if (!validNip98(input.profileQuery.authorization, { pubkey: input.ownerPubkey, url: `https://${input.host}/query`, method: "POST", body: input.profileQuery.body })) {
      throw new Error("invalid profile query grant");
    }
    const profileResponse = await relay("/query", input.communityId, { method: "POST", ...input.profileQuery });
    const profiles = profileResponse.ok ? await profileResponse.json() : [];
    const profilePubkeys = new Set(profiles.filter((event) => event.kind === 0 && verifyEvent(event)).map((event) => event.pubkey));
    if (input.profiles.some((profile) => !profilePubkeys.has(profile.pubkey))) throw new Error("employee profiles did not converge");

    return { relayPubkey: relayInfo.self, missing, unexpected, wrongRole, profileCount: profilePubkeys.size };
  }

  return { operatorPubkey, ensureCommunity, reconcileCommunity };
}
