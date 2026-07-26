import assert from "node:assert/strict";
import test from "node:test";

import { createEventProcessor, relayPost, serviceHeaders } from "./bridge.mjs";

test("service request signature binds the product path and body", () => {
  const headers = serviceHeaders({
    secret: "s".repeat(32),
    audience: "teams-agent-bridge:11111111-1111-4111-8111-111111111111",
    method: "POST",
    url: "https://app.ecombrain.io/api/internal/teams/agent/rpc",
    body: '{"action":"roster"}',
    now: 1_700_000_000_000,
    requestId: "22222222-2222-4222-8222-222222222222",
  });
  assert.match(headers.Authorization, /^Teams-HMAC [0-9a-f]{64}$/);
  assert.equal(headers["X-Teams-Service-Body-Sha256"].length, 64);
});

test("relay calls use public service transport while preserving canonical NIP-98 auth", async () => {
  const communityId = "11111111-1111-4111-8111-111111111111";
  let forwarded;
  const result = await relayPost({
    url: "https://tenant-1.teams.ecombrain.internal/query?limit=10",
    body: "[]",
    authorizationEvent: { id: "signed" },
  }, {
    baseUrl: "https://app.ecombrain.io",
    serviceSecret: "r".repeat(32),
    communityId,
    fetcher: async (url, init) => {
      forwarded = { url: String(url), init };
      return Response.json([]);
    },
  });

  assert.deepEqual(result, []);
  assert.equal(forwarded.url, "https://app.ecombrain.io/teams/service/relay/query?limit=10");
  assert.equal(forwarded.init.headers.Authorization, `Nostr ${Buffer.from('{"id":"signed"}').toString("base64")}`);
  assert.equal(forwarded.init.headers["X-Teams-Relay-Audience"], `teams-relay-service:agent:${communityId}`);
});

test("an accepted mention becomes one durable run, signed reply, publish, and ack", async () => {
  const calls = [];
  const callProduct = async (body) => {
    calls.push(body.action);
    if (body.action === "dispatch") return { runs: [{ bridgeRunId: "run-1" }] };
    if (body.action === "status") return { status: "succeeded" };
    return {};
  };
  const processEvent = createEventProcessor({
    callProduct,
    publishReply: async () => "a".repeat(64),
    wait: async () => undefined,
  });

  await processEvent({ id: "event-1" });

  assert.deepEqual(calls, ["dispatch", "status", "sign_reply", "ack_reply"]);
});

test("a pending run is never signed or acknowledged", async () => {
  const calls = [];
  const processEvent = createEventProcessor({
    callProduct: async (body) => {
      calls.push(body.action);
      return body.action === "dispatch"
        ? { runs: [{ bridgeRunId: "run-1" }] }
        : { status: "running" };
    },
    publishReply: async () => assert.fail("pending run must not publish"),
    wait: async () => undefined,
    maxPolls: 1,
  });

  await assert.rejects(processEvent({ id: "event-1" }), /polling deadline/);
  assert.deepEqual(calls, ["dispatch", "status"]);
});
