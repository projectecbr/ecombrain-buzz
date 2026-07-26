import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools";

import {
  createProvisioner,
  nip98Authorization,
} from "./provisioning.mjs";

const tenantId = "11111111-1111-4111-8111-111111111111";
const communityId = "22222222-2222-4222-8222-222222222222";
const host = `tenant-${tenantId}.teams.ecombrain.internal`;

function material() {
  const now = Math.floor(Date.now() / 1000);
  const ownerSecret = generateSecretKey();
  const memberSecret = generateSecretKey();
  const relaySecret = generateSecretKey();
  const ownerPubkey = getPublicKey(ownerSecret);
  const memberPubkey = getPublicKey(memberSecret);
  const profile = finalizeEvent({
    kind: 0,
    content: JSON.stringify({ name: "Agent", role: "Research" }),
    tags: [],
    created_at: now,
  }, memberSecret);
  const membership = finalizeEvent({
    kind: 9030,
    content: "",
    tags: [["p", memberPubkey], ["role", "member"]],
    created_at: now,
  }, ownerSecret);
  const eventUrl = `https://${host}/events`;
  const membershipBody = JSON.stringify(membership);
  const profileBody = JSON.stringify(profile);
  const membershipQueryBody = JSON.stringify([{ kinds: [13534], limit: 1 }]);
  const profileQueryBody = JSON.stringify([{ kinds: [0], authors: [memberPubkey], limit: 1 }]);
  return {
    ownerSecret,
    relaySecret,
    ownerPubkey,
    memberPubkey,
    profile,
    membership,
    request: {
      action: "reconcile",
      tenantId,
      communityId,
      host,
      ownerPubkey,
      members: [{
        pubkey: memberPubkey,
        role: "member",
        event: membership,
        authorization: nip98Authorization({ secret: ownerSecret, url: eventUrl, method: "POST", body: membershipBody }),
      }],
      profiles: [{
        pubkey: memberPubkey,
        event: profile,
        authorization: nip98Authorization({ secret: memberSecret, url: eventUrl, method: "POST", body: profileBody }),
      }],
      membershipQuery: {
        body: membershipQueryBody,
        authorization: nip98Authorization({ secret: ownerSecret, url: `https://${host}/query`, method: "POST", body: membershipQueryBody }),
      },
      profileQuery: {
        body: profileQueryBody,
        authorization: nip98Authorization({ secret: ownerSecret, url: `https://${host}/query`, method: "POST", body: profileQueryBody }),
      },
    },
  };
}

function provisioner(fetcher) {
  return createProvisioner({
    fetcher,
    publicBase: "https://app.ecombrain.io",
    operatorOrigin: "https://operator.teams.ecombrain.internal",
    operatorSecret: generateSecretKey(),
    operatorServiceSecret: "o".repeat(32),
    bunkerPubkey: "b".repeat(64),
    relayServiceMasterSecret: "r".repeat(32),
  });
}

describe("identity bridge provisioning", () => {
  it("converges a create-only conflict only when the requested owner already owns the host", async () => {
    const ownerPubkey = "a".repeat(64);
    const calls = [];
    const client = provisioner(async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === "POST") return Response.json({ error: "exists" }, { status: 409 });
      return Response.json({ owner_pubkey: ownerPubkey, communities: [{ community_id: communityId, host }] });
    });

    const result = await client.ensureCommunity({ tenantId, host, ownerPubkey });

    assert.deepEqual(result, { communityId, host, status: "existed", ownerPubkey });
    assert.equal(calls.length, 2);
    assert.match(calls[0].init.headers.Authorization, /^Nostr /);
    assert.equal(calls[0].init.headers["X-Teams-Operator-Audience"], `teams-relay-operator:${"b".repeat(64)}`);
    assert.match(calls[1].url, /owner_pubkey=/);
  });

  it("publishes missing canonical members and profiles, then trusts only the relay-signed snapshot", async () => {
    const input = material();
    const snapshot = finalizeEvent({
      kind: 13534,
      content: "",
      tags: [["-"], ["member", input.ownerPubkey, "owner"], ["member", input.memberPubkey, "member"], ["member", "c".repeat(64), "member"]],
      created_at: Math.floor(Date.now() / 1000),
    }, input.relaySecret);
    const client = provisioner(async (url, init) => {
      const parsed = new URL(url);
      assert.equal(init.headers["X-Teams-Relay-Audience"], `teams-relay-service:identity:${communityId}`);
      if (parsed.pathname === "/teams/service/relay") {
        return Response.json({ self: getPublicKey(input.relaySecret) });
      }
      if (parsed.pathname.endsWith("/events")) return Response.json({ accepted: true });
      const query = JSON.parse(init.body);
      return query[0].kinds[0] === 13534 ? Response.json([snapshot]) : Response.json([input.profile]);
    });

    const result = await client.reconcileCommunity(input.request);

    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.wrongRole, []);
    assert.deepEqual(result.unexpected, [{ pubkey: "c".repeat(64), role: "member" }]);
    assert.equal(result.relayPubkey, getPublicKey(input.relaySecret));
    assert.equal(result.profileCount, 1);
  });

  it("fails closed for a forged membership snapshot", async () => {
    const input = material();
    const forged = finalizeEvent({
      kind: 13534,
      content: "",
      tags: [["member", input.ownerPubkey, "owner"], ["member", input.memberPubkey, "member"]],
      created_at: Math.floor(Date.now() / 1000),
    }, generateSecretKey());
    const client = provisioner(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/teams/service/relay") return Response.json({ self: getPublicKey(input.relaySecret) });
      if (path.endsWith("/events")) return Response.json({ accepted: true });
      return Response.json([forged]);
    });
    await assert.rejects(() => client.reconcileCommunity(input.request), /membership snapshot/);
  });
});
