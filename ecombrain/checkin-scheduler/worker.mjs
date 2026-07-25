const encoder = new TextEncoder();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function serviceHeaders({ secret, url, body, now = Date.now(), requestId = crypto.randomUUID() }) {
  const issuedAt = Math.floor(now / 1_000);
  const expiresAt = issuedAt + 30;
  const audience = "teams-checkin-scheduler:control";
  const bodyHash = await digest(body);
  const canonical = ["POST", new URL(url).pathname, audience, issuedAt, expiresAt, requestId, bodyHash].join("\n");
  return {
    Authorization: `Teams-HMAC ${await hmac(secret, canonical)}`,
    "Content-Type": "application/json",
    "X-Teams-Service-Audience": audience,
    "X-Teams-Service-Issued-At": String(issuedAt),
    "X-Teams-Service-Expires-At": String(expiresAt),
    "X-Teams-Service-Request-Id": requestId,
    "X-Teams-Service-Body-Sha256": bodyHash,
  };
}

export async function runCheckins(env, fetcher = fetch) {
  const secret = env.TEAMS_SCHEDULER_SERVICE_SECRET?.trim();
  const baseUrl = env.TEAMS_PRODUCT_API_URL?.trim();
  if (!secret || secret.length < 32 || !baseUrl) throw new Error("scheduler configuration is incomplete");
  const productUrl = new URL("/api/internal/teams/checkins/rpc", baseUrl).toString();
  const productCall = async (payload) => {
    const body = JSON.stringify(payload);
    const response = await fetcher(productUrl, {
      method: "POST",
      headers: await serviceHeaders({ secret, url: productUrl, body }),
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`product scheduler API rejected request (${response.status})`);
    return response.json();
  };

  const claim = await productCall({ action: "claim_due" });
  const due = Array.isArray(claim.due) ? claim.due.slice(0, 50) : [];
  const results = await Promise.allSettled(due.map(async (item) => {
    const body = JSON.stringify({
      teamId: item.teamId,
      roomId: item.roomId,
      scheduledFor: item.scheduledFor,
      fireId: item.fireId,
      leadAgentPubkey: item.leadAgentPubkey,
    });
    const delivered = await fetcher(item.hookUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": item.hookSecret,
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!delivered.ok) throw new Error(`relay webhook rejected request (${delivered.status})`);
    await productCall({
      action: "ack_delivery",
      teamId: item.teamId,
      scheduledFor: item.scheduledFor,
      fireId: item.fireId,
    });
  }));
  return {
    claimed: due.length,
    delivered: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
  };
}

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCheckins(env).then((result) => {
      if (result.failed > 0) throw new Error(`${result.failed} Teams check-in deliveries failed`);
    }));
  },
  async fetch() {
    return new Response("Not found", { status: 404 });
  },
};
