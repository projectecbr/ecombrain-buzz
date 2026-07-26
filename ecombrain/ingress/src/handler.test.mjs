import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { createIngressHandler, serviceHeaders } from "./handler.ts";

const token = "a".repeat(43);
const secret = "s".repeat(32);

function relayEnv(onRelay) {
  return {
    TEAMS_INGRESS_SERVICE_SECRET: secret,
    TEAMS_PRODUCT_API_URL: "https://app.ecombrain.io",
    RELAY: {
      idFromName: (name) => name,
      get: () => ({ fetch: onRelay }),
    },
  };
}

describe("Teams ingress", () => {
  it("rejects missing sessions without calling the product or relay", async () => {
    let called = false;
    const handle = createIngressHandler(async () => {
      called = true;
      return new Response();
    });
    const response = await handle(
      new Request("https://app.ecombrain.io/teams/relay"),
      relayEnv(async () => {
        called = true;
        return new Response();
      }),
    );

    assert.equal(response.status, 401);
    assert.equal(called, false);
  });

  it("routes only to the session-bound host and strips spoofing headers", async () => {
    let forwarded;
    const handle = createIngressHandler(async (_url, init) => {
      assert.equal(JSON.parse(init.body).token, token);
      return Response.json({
        communityHost: "tenant-1.teams.ecombrain.internal",
        expiresAt: Date.now() + 900_000,
      });
    });
    const response = await handle(
      new Request(
        "https://app.ecombrain.io/teams/relay/media/file?download=1",
        {
          headers: {
            Authorization: "Nostr signed-event",
            Cookie: `other=x; ecombrain_teams_session=${token}`,
            "X-Forwarded-Host": "attacker.example",
            "X-Spike-Tenant-Override": "attacker.teams.ecombrain.internal",
            "X-Teams-Tenant": "attacker-tenant",
          },
        },
      ),
      relayEnv(async (request) => {
        forwarded = request;
        return new Response("relay-ok");
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "relay-ok");
    assert.equal(forwarded.url, "http://relay/media/file?download=1");
    assert.equal(
      forwarded.headers.get("host"),
      "tenant-1.teams.ecombrain.internal",
    );
    assert.equal(forwarded.headers.get("authorization"), "Nostr signed-event");
    assert.equal(forwarded.headers.get("cookie"), null);
    assert.equal(forwarded.headers.get("x-forwarded-host"), null);
    assert.equal(forwarded.headers.get("x-spike-tenant-override"), null);
    assert.equal(forwarded.headers.get("x-teams-tenant"), null);
  });

  it("fails closed when product validation fails or returns an unsafe host", async () => {
    const relay = relayEnv(async () => {
      throw new Error("relay must not be reached");
    });
    const revoked = createIngressHandler(async () =>
      Response.json({}, { status: 401 }),
    );
    assert.equal(
      (
        await revoked(
          new Request("https://app.ecombrain.io/teams/relay", {
            headers: { Cookie: `ecombrain_teams_session=${token}` },
          }),
          relay,
        )
      ).status,
      401,
    );

    const spoofed = createIngressHandler(async () =>
      Response.json({ communityHost: "evil.example:443" }),
    );
    assert.equal(
      (
        await spoofed(
          new Request("https://app.ecombrain.io/teams/relay", {
            headers: { Cookie: `ecombrain_teams_session=${token}` },
          }),
          relay,
        )
      ).status,
      503,
    );
  });

  it("binds the product request method, path, audience, time, id, and body", async () => {
    const body = JSON.stringify({ token });
    const headers = await serviceHeaders({
      secret,
      url: "https://app.ecombrain.io/api/internal/teams/ingress/session",
      body,
      now: 1_000_000,
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    const canonical = [
      "POST",
      "/api/internal/teams/ingress/session",
      "teams-ingress:relay",
      "1000",
      "1030",
      "11111111-1111-4111-8111-111111111111",
      headers["X-Teams-Service-Body-Sha256"],
    ].join("\n");
    assert.equal(
      headers.Authorization,
      `Teams-HMAC ${createHmac("sha256", secret).update(canonical).digest("hex")}`,
    );
  });
});
