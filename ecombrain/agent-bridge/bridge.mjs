import { createHash, createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const TERMINAL = new Set(["succeeded", "failed", "budget_exhausted"]);

export function serviceHeaders({ secret, audience, method, url, body, now = Date.now(), requestId = randomUUID() }) {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 30;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const canonical = [method, new URL(url).pathname, audience, issuedAt, expiresAt, requestId, bodyHash].join("\n");
  return {
    Authorization: `Teams-HMAC ${createHmac("sha256", secret).update(canonical).digest("hex")}`,
    "Content-Type": "application/json",
    "X-Teams-Service-Audience": audience,
    "X-Teams-Service-Issued-At": String(issuedAt),
    "X-Teams-Service-Expires-At": String(expiresAt),
    "X-Teams-Service-Request-Id": requestId,
    "X-Teams-Service-Body-Sha256": bodyHash,
  };
}

export function createEventProcessor({ callProduct, publishReply, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxPolls = 450 }) {
  async function finishRun(run) {
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const status = await callProduct({ action: "status", bridgeRunId: run.bridgeRunId });
      if (status.status === "replied") return;
      if (!TERMINAL.has(status.status)) {
        await wait(2_000);
        continue;
      }
      await callProduct({ action: "sign_reply", bridgeRunId: run.bridgeRunId });
      const eventId = await publishReply(run.bridgeRunId);
      await callProduct({ action: "ack_reply", bridgeRunId: run.bridgeRunId, eventId });
      return;
    }
    throw new Error("agent run did not finish before the polling deadline");
  }

  return async function processEvent(event) {
    const dispatched = await callProduct({ action: "dispatch", event });
    for (const run of dispatched.runs ?? []) await finishRun(run);
  };
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function nostrAuthorization(event) {
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64")}`;
}

export function relayServiceHeaders({ secret, communityId, method, url, body, now = Date.now(), requestId = randomUUID() }) {
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + 30;
  const audience = `teams-relay-service:agent:${communityId}`;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const parsed = new URL(url);
  const canonical = [method, `${parsed.pathname}${parsed.search}`, audience, issuedAt, expiresAt, requestId, bodyHash].join("\n");
  return {
    "X-Teams-Relay-Authorization": `Teams-HMAC ${createHmac("sha256", secret).update(canonical).digest("hex")}`,
    "X-Teams-Relay-Audience": audience,
    "X-Teams-Relay-Issued-At": String(issuedAt),
    "X-Teams-Relay-Expires-At": String(expiresAt),
    "X-Teams-Relay-Request-Id": requestId,
    "X-Teams-Relay-Body-Sha256": bodyHash,
  };
}

export async function relayPost(grant, { baseUrl, serviceSecret, communityId, fetcher = fetch }) {
  const canonical = new URL(grant.url);
  const transport = new URL(`/teams/service/relay${canonical.pathname}${canonical.search}`, baseUrl);
  const response = await fetcher(transport, {
    method: "POST",
    headers: {
      Authorization: nostrAuthorization(grant.authorizationEvent),
      "Content-Type": "application/json",
      ...relayServiceHeaders({ secret: serviceSecret, communityId, method: "POST", url: transport, body: grant.body }),
    },
    body: grant.body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`relay request failed (${response.status})`);
  return response.json();
}

export async function startBridge() {
  const communityId = requiredEnv("TEAMS_COMMUNITY_ID");
  const serviceSecret = requiredEnv("TEAMS_AGENT_SERVICE_SECRET");
  const relayServiceSecret = requiredEnv("TEAMS_RELAY_SERVICE_SECRET");
  const productBase = requiredEnv("TEAMS_PRODUCT_API_URL");
  const productUrl = new URL(
    "/api/internal/teams/agent/rpc",
    productBase,
  ).toString();
  if (serviceSecret.length < 32 || relayServiceSecret.length < 32) throw new Error("agent bridge secret is too short");
  const audience = `teams-agent-bridge:${communityId}`;
  const callProduct = async (body) => {
    const rawBody = JSON.stringify(body);
    const response = await fetch(productUrl, {
      method: "POST",
      headers: serviceHeaders({ secret: serviceSecret, audience, method: "POST", url: productUrl, body: rawBody }),
      body: rawBody,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`product agent API rejected request (${response.status})`);
    return response.json();
  };
  const publishReply = async (bridgeRunId) => {
    const grant = await callProduct({ action: "sign_publish_auth", bridgeRunId });
    const event = JSON.parse(grant.body);
    const result = await relayPost(grant, {
      baseUrl: productBase,
      serviceSecret: relayServiceSecret,
      communityId,
    });
    if (result.accepted === false) throw new Error("relay rejected the agent reply");
    return event.id;
  };
  const processEvent = createEventProcessor({ callProduct, publishReply });

  await callProduct({ action: "roster" });
  let since = Math.floor(Date.now() / 1000) - 86_400;
  for (;;) {
    try {
      const grant = await callProduct({ action: "poll_auth", since });
      const events = await relayPost(grant, {
        baseUrl: productBase,
        serviceSecret: relayServiceSecret,
        communityId,
      });
      if (!Array.isArray(events)) throw new Error("relay query returned an invalid body");
      events.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
      for (const event of events) {
        try {
          await processEvent(event);
        } catch (error) {
          console.error("[teams-agent-bridge] event failed:", error instanceof Error ? error.message : "unknown error");
        }
      }
      const newest = events.reduce((value, event) => Math.max(value, Number(event.created_at) || 0), since);
      since = Math.max(Math.floor(Date.now() / 1000) - 86_400, newest - 60);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    } catch (error) {
      console.error("[teams-agent-bridge] poll failed:", error instanceof Error ? error.message : "unknown error");
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startBridge().catch((error) => {
    console.error("[teams-agent-bridge] startup failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
