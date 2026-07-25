import assert from "node:assert/strict";
import test from "node:test";

import { createEventProcessor, serviceHeaders } from "./bridge.mjs";

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
