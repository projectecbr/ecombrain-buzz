import assert from "node:assert/strict";
import test from "node:test";

import { runCheckins, serviceHeaders } from "./worker.mjs";

const env = {
  TEAMS_PRODUCT_API_URL: "https://app.ecombrain.io",
  TEAMS_SCHEDULER_SERVICE_SECRET: "s".repeat(32),
};
const due = {
  teamId: "11111111-1111-4111-8111-111111111111",
  roomId: "22222222-2222-4222-8222-222222222222",
  hookUrl: "https://teams.example/hooks/33333333-3333-4333-8333-333333333333",
  hookSecret: "h".repeat(32),
  scheduledFor: "2026-07-25T09:00:00.000Z",
  fireId: "f".repeat(64),
  leadAgentPubkey: "a".repeat(64),
};

test("service authentication binds the product path and body", async () => {
  const headers = await serviceHeaders({
    secret: env.TEAMS_SCHEDULER_SERVICE_SECRET,
    url: "https://app.ecombrain.io/api/internal/teams/checkins/rpc",
    body: '{"action":"claim_due"}',
    now: 1_700_000_000_000,
    requestId: "44444444-4444-4444-8444-444444444444",
  });
  assert.match(headers.Authorization, /^Teams-HMAC [0-9a-f]{64}$/);
  assert.equal(headers["X-Teams-Service-Audience"], "teams-checkin-scheduler:control");
});

test("a durable claim is delivered once and acknowledged after relay acceptance", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url === due.hookUrl) return { ok: true, status: 202 };
    if (body.action === "claim_due") return { ok: true, json: async () => ({ due: [due] }) };
    return { ok: true, json: async () => ({ acknowledged: true }) };
  };

  assert.deepEqual(await runCheckins(env, fetcher), { claimed: 1, delivered: 1, failed: 0 });
  assert.deepEqual(calls.map((call) => call.body.action ?? "webhook"), ["claim_due", "webhook", "ack_delivery"]);
  assert.equal(calls[1].headers["X-Webhook-Secret"], due.hookSecret);
  assert.equal(calls[1].body.leadAgentPubkey, due.leadAgentPubkey);
});

test("a rejected relay delivery is retried later and never acknowledged", async () => {
  const actions = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    actions.push(body.action ?? "webhook");
    if (url === due.hookUrl) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ due: [due] }) };
  };

  assert.deepEqual(await runCheckins(env, fetcher), { claimed: 1, delivered: 0, failed: 1 });
  assert.deepEqual(actions, ["claim_due", "webhook"]);
});
