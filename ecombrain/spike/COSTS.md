# Phase 0 COSTS (preliminary — CF actuals pending billing unblock)

Date: 2026-07-25

## Committed spend so far

$0. No paid CF features enabled. Supabase/Upstash use existing staging resources
(`buzz_staging` database, shared staging Redis) at no incremental cost. GitHub
Actions minutes: fork is public → free.

## Approved projection (spec §9, unchanged by Phase 0 findings)

| Item | Monthly |
|------|---------|
| Workers Paid | $5.00 |
| Container standard-1 24/7 (RAM ≈ $26 + disk ≈ $1.40 + CPU $0–26) | $27–53 |
| R2 (10GB free tier; ~$0.15 expected) | ~$0.15 |
| Egress within 1TB | $0 |
| **Total baseline (~100 active tenants)** | **≈ $35–65** |

Stop line: $150/mo (contract). Current projection is < half of it.

## Required one-time account actions (money-boundary report 2026-07-25)

1. Workers Free → **Paid ($5/mo)** — required for Containers.
2. **R2 activation ($0/mo base)** — requires a payment method on file.

## Measured data points (local, directional only)

- Relay image size: 310MB (ghcr.io/projectecbr/ecombrain-buzz-relay:0.2.0).
- Local container footprint during pre-flight: idle relay well under standard-1's
  2GB RAM (exact numbers from the CF soak will replace this line).
- WS fan-out cost driver: Redis pub/sub + Postgres writes per event — both on
  existing plans; no per-event CF cost.

## To be measured at Task 6/7 (soak window)

- Container RAM-seconds/CPU-seconds/disk over 2h + 24h soak (CF metrics).
- Worker requests (ingress), R2 storage/ops.
- Projection to 24/7 + 100 tenants; comparison vs the table above.
