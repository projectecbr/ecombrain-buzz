# Spike environment contract (Phase 0) — names and sources only, NO values

Doppler: project `ecombrain`, config `stg_teams` (branch config of `stg`; plan said
`teams_staging` — Doppler enforces the `stg_` prefix for the stg environment).
Branch configs inherit all `stg` keys; the keys below are spike-specific overrides.

| Key | Source | Where the value lives |
|-----|--------|-----------------------|
| `DATABASE_URL` | Supabase staging project `omknchjybqvkxdgnapui` (eu-west-1), database `buzz_staging` (created 2026-07-25 via psql `CREATE DATABASE`, additive only), session pooler IPv4 :5432, `sslmode=require`. NOTE: true direct host `db.<ref>.supabase.co` is IPv6-only — CF Containers have no guaranteed IPv6 egress, so pooler session-mode (port 5432, NOT transaction 6543) is the container path. | Doppler `stg_teams` |
| `REDIS_URL` | Upstash staging (`proven-sunbird-148975`), TLS `rediss://` TCP endpoint derived from the existing staging REST credentials. PSUBSCRIBE roundtrip verified 2026-07-25 (A2 protocol pre-check). Shared staging DB — spike uses `buzzspike.*`/presence keyspace only; dedicated DB recommended for Phase 1. | Doppler `stg_teams` |
| `RELAY_OPERATOR_PUBKEYS` | generated keypair (openssl/nostr-tools, 2026-07-25) | Doppler `stg_teams` |
| `OPERATOR_NSEC` | secret half of the same keypair (hex) | Doppler `stg_teams` + `/tmp/buzz-spike/operator-secret.hex` (0600) |
| `RELAY_OPERATOR_API_ORIGIN` | `https://ecombrain-teams-spike.yannis-83d.workers.dev` (workers subdomain `yannis-83d`) | Doppler `stg_teams` |
| `TEAMS_PRODUCT_API_URL` | Product origin used only for the ingress session-validation call | Worker vars (`wrangler.jsonc`) |
| `TEAMS_INGRESS_SERVICE_SECRET` | 32+ byte HMAC secret shared only by the ingress Worker and product validation route | Worker secret + product runtime secret |
| `TEAMS_RELAY_SERVICE_SECRET` | Master HMAC key held by the ingress Worker plus the global identity and scheduler controllers. Per-community agent deployments receive `HMAC(master, "teams-relay-service:<service>:<communityId>")`, never the master. | Worker + identity bridge + scheduler secret; derived value in each agent deployment |
| `BUZZ_BIND_ADDR` | `0.0.0.0:3000` (verified env name in `crates/buzz-relay/src/config.rs:225`; plan's `LISTEN_ADDR` was wrong) | Doppler `stg_teams` |
| `BUZZ_HUDDLE_AUDIO_AVAILABLE` | `false` (huddle kill-switch, spec §3.1) | Doppler `stg_teams` |
| `BUZZ_S3_ENDPOINT` | R2 S3 endpoint for account `2b4b7eb9…cf45` | Doppler `stg_teams` |
| `BUZZ_S3_BUCKET` | `ecombrain-teams-media-staging` | Doppler `stg_teams` |
| `BUZZ_S3_REGION` | `auto` (R2) | Doppler `stg_teams` |
| `BUZZ_S3_ACCESS_KEY` / `BUZZ_S3_SECRET_KEY` | R2 API token — **BLOCKED**: R2 not enabled on the CF account; activation needs a payment method (see GO-NOGO / money-boundary report) | pending |

## Continuation service contract

These names are implemented locally but are not deployment proof:

| Key | Scope | Required contract |
|-----|-------|-------------------|
| `TEAMS_BUNKER_PUBKEY` | Product | Public key derived from the identity bridge bunker key. Public value only. |
| `TEAMS_BUNKER_SECRET_KEY` | Identity bridge | Private bunker transport key. Never copied into the product, browser, relay bindings, or logs. |
| `TEAMS_IDENTITY_BRIDGE_SECRET` | Product + identity bridge | 32+ byte HMAC key for product RPC calls. Bound to the configured bunker public-key subject. |
| `TEAMS_PROVISIONING_CONTROL_SECRET` | Product + identity bridge | 32+ byte HMAC key for short-lived `/teams/service/identity/provision` control requests. Separate from bunker RPC auth. |
| `TEAMS_OPERATOR_SERVICE_SECRET` | Ingress Worker + identity bridge | 32+ byte HMAC key for `/teams/service/operator/*`; audience is pinned to `TEAMS_BUNKER_PUBKEY`. |
| `TEAMS_OPERATOR_SECRET_KEY` | Identity bridge | Deployment operator Nostr secret key. Its public key is the relay's only operator allowlist entry. |
| `TEAMS_OPERATOR_API_ORIGIN` | Identity bridge | Canonical origin used in native operator NIP-98 `u` tags; equals the relay's `RELAY_OPERATOR_API_ORIGIN`. |
| `TEAMS_IDENTITY_BRIDGE_CONTROL_URL` | Product | Same-origin HTTPS endpoint `/teams/service/identity/provision`; never sent to the browser. |
| `TEAMS_RELAY_URL` | Browser data client | Public same-origin `/teams/relay` transport only. NIP-42/NIP-98 must be signed for the separate tenant-internal canonical auth URL returned by the product binding. |
| `TEAMS_BUNKER_URL` | Browser + identity bridge | Same-origin `/teams/bunker` WebSocket routed directly to the identity bridge. It is not the membership-gated Buzz data relay. |
| `TEAMS_COMMUNITY_ID` | One agent-bridge deployment | UUID of exactly one provisioned community. Used as the service audience subject, never accepted from an event or request body. |
| `TEAMS_AGENT_SERVICE_SECRET` | Product | Master used only by the product to derive `HMAC(master, "teams-agent-bridge:<communityId>")`. |
| `TEAMS_AGENT_SERVICE_SECRET` | One agent-bridge deployment | The derived key for that deployment's `TEAMS_COMMUNITY_ID`, not the product master. |
| `TEAMS_SCHEDULER_SERVICE_SECRET` | Product + scheduler Worker | 32+ byte HMAC key scoped to `teams-checkin-scheduler:control`. |
| `TEAMS_PRODUCT_API_URL` | Ingress + all bridges/workers | HTTPS product origin. No embedded path, query credential, or tenant selector. |

The local implementation now wires the per-community service-HMAC callers,
direct `/teams/bunker` identity-bridge route, public-transport/canonical-auth
split, operator control path, and provisioning control path. Their focused
positive and negative contracts pass locally. Deployment and authenticated edge
proof remain part of the Cloudflare-last gate; the browser cookie path remains
intentionally insufficient for server processes.

## Deviations from the plan discovered so far
- Fork org is `projectecbr` (Hesk123 redirects there), fork: `projectecbr/ecombrain-buzz`.
- `BUZZ_REQUIRE_MEDIA_GET_AUTH` does NOT exist at relay-v0.2.0 (spec said VERIFIED) — actual media GET auth mechanism under investigation (see spike RESULTS.md).
- `LISTEN_ADDR` → real name is `BUZZ_BIND_ADDR`.
- Local dev ports remapped 5432→6432, 6379→6479 (host runs brew postgres/redis); dev-setup.sh redis guard narrowed accordingly (this branch only).
