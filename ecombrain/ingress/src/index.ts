// EcomBrain Teams spike ingress Worker (Phase 0 Task 5).
// Only public path to the relay: injects the synthetic tenant Host (Buzz's
// native community tenancy, verified tenant.rs) and proxies WS+HTTP into the
// unpatched relay container. Client-supplied Host headers never reach the relay.
//
// Relay env comes from Worker Secrets (wrangler secret put) + vars above,
// passed to the container via envVars (CF Containers env mechanism, see
// https://developers.cloudflare.com/containers/examples/env-vars-and-secrets/).
// Required Worker Secrets: DATABASE_URL, REDIS_URL, BUZZ_S3_ACCESS_KEY,
// BUZZ_S3_SECRET_KEY, RELAY_OPERATOR_PUBKEYS.
import { Container } from "@cloudflare/containers";
import { env } from "cloudflare:workers";

const TENANT_HOST = "tenant-spike.teams.ecombrain.internal"; // provisioned via verify.mjs provision

export class RelayContainer extends Container {
  defaultPort = 3000;
  sleepAfter = "2h"; // spike: observe sleep behavior vs active WS (CF containers bug #162 watch)
  envVars = {
    DATABASE_URL: env.DATABASE_URL,
    REDIS_URL: env.REDIS_URL,
    BUZZ_S3_ENDPOINT: env.BUZZ_S3_ENDPOINT,
    BUZZ_S3_ACCESS_KEY: env.BUZZ_S3_ACCESS_KEY,
    BUZZ_S3_SECRET_KEY: env.BUZZ_S3_SECRET_KEY,
    BUZZ_S3_BUCKET: env.BUZZ_S3_BUCKET,
    BUZZ_S3_REGION: env.BUZZ_S3_REGION,
    RELAY_OPERATOR_PUBKEYS: env.RELAY_OPERATOR_PUBKEYS,
    RELAY_OPERATOR_API_ORIGIN: env.RELAY_OPERATOR_API_ORIGIN,
    RELAY_URL: env.RELAY_URL,
    BUZZ_MEDIA_BASE_URL: env.BUZZ_MEDIA_BASE_URL,
    BUZZ_BIND_ADDR: env.BUZZ_BIND_ADDR,
    BUZZ_HUDDLE_AUDIO_AVAILABLE: env.BUZZ_HUDDLE_AUDIO_AVAILABLE,
  };
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    // Spike-only test backdoor (REMOVED in production): lets verify.mjs bind a
    // second tenant for the cross-tenant 404 check. Requires the test secret.
    let host = TENANT_HOST;
    const override = request.headers.get("x-spike-tenant-override");
    if (override && env.SPIKE_TEST_SECRET && request.headers.get("x-spike-secret") === env.SPIKE_TEST_SECRET) {
      host = override;
    }
    headers.set("Host", host); // Buzz resolves community from Host (verified, tenant.rs)
    headers.delete("x-spike-tenant-override");
    headers.delete("x-spike-secret");
    const relay = env.RELAY.get(env.RELAY.idFromName("relay-singleton"));
    return relay.fetch(new Request(new URL(url.pathname + url.search, "http://relay"), {
      method: request.method,
      headers,
      body: request.body,
    }));
  },
};
