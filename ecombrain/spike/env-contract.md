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
| `RELAY_OPERATOR_API_ORIGIN` | `https://ecombrain-teams-spike.coveandlinen.workers.dev` (workers subdomain `coveandlinen`) | Doppler `stg_teams` |
| `BUZZ_BIND_ADDR` | `0.0.0.0:3000` (verified env name in `crates/buzz-relay/src/config.rs:225`; plan's `LISTEN_ADDR` was wrong) | Doppler `stg_teams` |
| `BUZZ_HUDDLE_AUDIO_AVAILABLE` | `false` (huddle kill-switch, spec §3.1) | Doppler `stg_teams` |
| `BUZZ_S3_ENDPOINT` | R2 S3 endpoint for account `2b4b7eb9…cf45` | Doppler `stg_teams` |
| `BUZZ_S3_BUCKET` | `ecombrain-teams-media-staging` | Doppler `stg_teams` |
| `BUZZ_S3_REGION` | `auto` (R2) | Doppler `stg_teams` |
| `BUZZ_S3_ACCESS_KEY` / `BUZZ_S3_SECRET_KEY` | R2 API token — **BLOCKED**: R2 not enabled on the CF account; activation needs a payment method (see GO-NOGO / money-boundary report) | pending |

## Deviations from the plan discovered so far
- Fork org is `projectecbr` (Hesk123 redirects there), fork: `projectecbr/ecombrain-buzz`.
- `BUZZ_REQUIRE_MEDIA_GET_AUTH` does NOT exist at relay-v0.2.0 (spec said VERIFIED) — actual media GET auth mechanism under investigation (see spike RESULTS.md).
- `LISTEN_ADDR` → real name is `BUZZ_BIND_ADDR`.
- Local dev ports remapped 5432→6432, 6379→6479 (host runs brew postgres/redis); dev-setup.sh redis guard narrowed accordingly (this branch only).
