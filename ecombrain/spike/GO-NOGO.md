# Phase 0 GO/NO-GO — Buzz relay on Cloudflare (PRELIMINARY)

**Status: PRELIMINARY — CF deploy legs (A1, A3/A6-R2, edge A5, costs) pending the
billing unblock (Workers Paid $5/mo + R2 activation $0/mo; money-boundary report
sent 2026-07-25). Verdict will be finalized after the Task 5/6 deploy legs and the
24h soak. Nothing measured so far threatens D2 (Cloudflare-only).**

Date: 2026-07-25. Pin: relay-v0.2.0 + desktop v0.4.25 @ 0d9be2fde1fc18e57da8f2ca229cc01699867550.

## Evidence per assumption

| # | Assumption | Status | Evidence (committed where noted) |
|---|-----------|--------|----------------------------------|
| A1 | CF Containers sustain an always-on WS relay | **PENDING (billing)** | Deploy + 2h/24h soak ready to run: `ecombrain/ingress/` (worker + wrangler.jsonc), `verify.mjs soak`. No evidence against viability collected |
| A2 | Upstash PSUBSCRIBE from a container over TLS | **PASS** | TLS PSUBSCRIBE roundtrip 2026-07-25 (local); relay container booted with staging `REDIS_URL` → "Redis pub/sub connected"; WS roundtrip through tenant host 10/10 (RESULTS.md) |
| A3 | rust-s3 path-style works incl. checksum behavior | mechanics **PASS** (MinIO) / R2 leg pending | Blossom upload/download byte-identical via the relay's own S3 path (RESULTS.md); R2-specific leg needs the enabled bucket |
| A4 | Supabase direct TCP from a container is stable | **PASS** (via session pooler — direct host is IPv6-only, deviation recorded) | `buzz_staging` migrated (40 tables); relay container "Postgres connected"; provision + event writes verified (RESULTS.md) |
| A5 | NIP-46 bunker signing latency acceptable | local leg **PASS** / edge leg pending | Local sign p50 2.2ms / p95 2.6ms → ~297ms RTT headroom against the 300ms p95 budget (RESULTS.md) |
| A6 | R2 checksum quirk doesn't break rust-s3 | **PENDING (billing)** | runs with A3-R2 leg |

## Spec/plan deviations discovered (all in RESULTS.md, committed)

1. `BUZZ_REQUIRE_MEDIA_GET_AUTH` does not exist at this pin — media GET unauthenticated,
   tenant gate = Host-bound sidecar (fail-closed 404, cross-tenant 404 VERIFIED).
2. Supabase direct host IPv6-only → session pooler is the container DB path.
3. `LISTEN_ADDR` → `BUZZ_BIND_ADDR`; media endpoints are `PUT /media/upload` + `GET /media/{sha256_ext}`.
4. NIP-42 mandatory on WS; NIP-98 same-second replay collision (bridge design note).
5. Fork org is `projectecbr` (Hesk123 redirects); relay image mirrored to
   `ghcr.io/projectecbr/ecombrain-buzz-relay:0.2.0` (unpatched upstream build).
6. "Builderlab" does not exist at this pin (Phase 2 removal list shrinks accordingly).

## Cost reality vs projection (details in COSTS.md)

Projection unchanged: ≈ $35–65/mo baseline (Workers Paid $5 + standard-1 container
24/7 + R2 + egress). No actuals yet (billing-blocked). **No indication of crossing
the $150/mo stop line.**

## Top residual risks (pre-deploy)

1. A1 sleep semantics (CF containers bug #162) — untested until the soak; mitigation
   ready (keepalive REQ every 10s, `sleepAfter="2h"`, Buzz-native reconnect UX).
2. Media GET unauthenticated (deviation 1) — bearer-link exposure inside a tenant;
   pen-test must re-verify in Phase 4; Worker-level signed URLs or small upstream
   patch if unacceptable (decision deferred, NOT a D2 breaker).
3. Upstream velocity — pin + monthly sync policy already in place (FORK-PIN.md).

## Recommended instance class

standard-1 for staging and initial production (spec §9); load test in Phase 6
validates before tenant growth.

## Fallback options (spec §12, verbatim — only if final verdict is NO-GO)

- Phase 0 no-go on Containers → options for Yannis: (a) relay on VPS/managed
  container with CF in front (breaks D2 purity, keeps everything else), (b)
  wait/retry with CF engineering engagement, (c) pause program. Decision
  belongs to Yannis with CTO recommendation.
- Upstash no-go → in-container Redis sidecar (documented, ephemeral-OK).
- R2/rust-s3 no-go → escalate; media must land in R2 or the decision goes back to Yannis.
