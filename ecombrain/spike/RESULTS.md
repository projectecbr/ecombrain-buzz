# Phase 0 spike — RESULTS (live document)

Pin: relay-v0.2.0 + desktop v0.4.25 @ 0d9be2fde1fc18e57da8f2ca229cc01699867550.
Status: IN PROGRESS — A1/A3/A6 blocked on CF billing (see GO-NOGO.md), local evidence below is final.

| Check | Result | Evidence |
|-------|--------|----------|
| A1 CF Containers always-on | BLOCKED (billing) | account on Workers Free; Containers need Paid ($5/mo) — money-boundary report sent 2026-07-25 |
| A2 Upstash PSUBSCRIBE from container | PASS (protocol) / container leg pending | `redis-cli psubscribe buzzspike.*` over `rediss://` to staging Upstash received published message, 2026-07-25 (local pre-check; container egress leg runs with Task 6) |
| A3 R2 via rust-s3 | BLOCKED (billing) | R2 not enabled on account; $0 base activation needs payment method |
| A4 Supabase TCP from container | local leg PASS / container leg pending | `buzz_staging` created on staging project `omknchjybqvkxdgnapui`, psql roundtrip OK. NOTE: `db.<ref>.supabase.co` is IPv6-only; containers will use the session pooler (IPv4, port 5432) — sqlx over session pooler behaves as direct TCP for our purposes; documented in env-contract.md |
| A5 bunker signing latency | local leg pending (bench in verify.mjs) | model: edge RTT + local sign |
| A6 R2 checksum quirk | BLOCKED (billing) | with A3 |

## Verified deviations from spec/plan (important for Phase 1+)

1. **`BUZZ_REQUIRE_MEDIA_GET_AUTH` does not exist** at relay-v0.2.0 (workspace-wide search: zero matches).
   Media GET `/media/{sha256_ext}` is UNAUTHENTICATED by design (`crates/buzz-relay/src/api/media.rs:508`,
   router has no auth middleware, `crates/buzz-relay/src/router.rs:37-44,95`). Tenant isolation on reads is
   the Host-bound sidecar gate `_meta/{community}/{sha}.json` (media.rs:516-545, `crates/buzz-media/src/storage.rs:177-232`)
   — fail-closed 404, cross-tenant indistinguishable from missing. Consequence: media URLs are capability
   URLs inside a tenant namespace; the ingress Worker (only network path) makes cross-tenant access impossible,
   but in-room media links are bearer links for that tenant. Phase 4 pen-test must re-verify; if link-sharing
   within a tenant is unacceptable, this needs a small upstream patch or Worker-level signed URLs — decision deferred to Phase 4.
2. **Fork org**: `projectecbr/ecombrain-buzz` (Hesk123 is a user namespace redirecting to that org).
3. **Env var**: plan's `LISTEN_ADDR` → real name `BUZZ_BIND_ADDR` (config.rs:225).
4. **Media endpoints**: `PUT /media/upload` (Blossom kind:24242 auth) + `GET /media/{sha256_ext}` — NOT `/upload`.
5. **Upstream image**: `ghcr.io/block/buzz:0.2.0` (multi-arch, public) — relay runs UNPATCHED, so the spike
   deploys the upstream image mirrored to our registry instead of a local amd64 qemu build.
6. **Supabase direct host is IPv6-only** — container path is the session pooler (see A4).
7. **Local dev ports**: host brew postgres/redis occupy 5432/6379 → Buzz dev remapped to 6432/6479 (branch-local).

## Local baseline (Task 2) — PASS
- Toolchain: Hermit → Rust 1.95.0, Node 24.14.0, just 1.46.0.
- `just setup`: compose services up (postgres:17 on 6432, redis:7 on 6479, minio on 9000/9001;
  keycloak unhealthy — verified unused; prometheus bind-mount failed, /Volumes not mounted into the
  Colima VM — irrelevant to the spike, noted for Phase 1 if local monitoring is wanted).
  minio-init had not created `buzz-media` (first setup run died on the creds-helper bug); created
  manually via `mc` — relay's git object-store conformance probe then passed (2 transport drops in
  96 race ops under local MinIO; probe still admitted the backend).
- Relay runs on **port 3333**, not 3000: canonical EcomBrain next-server owns :3000 (pid 19961,
  cwd = canonical checkout — left untouched per repo rules). `.env`: BUZZ_BIND_ADDR/RELAY_URL updated.
- Roundtrip: `buzz-cli` channel create → message send → messages get — event accepted and read back
  (event id a2e6d12b…0477, kind 9). Proves WS/REST + Postgres + Redis + MinIO path.
- Unit tests `just test-unit`: **ALL PASS** at the pin (buzz-core, buzz-auth, buzz-db, buzz-conformance).

## Relay image (Task 3) — PASS (mirror variant)
- Deploying the UNPATCHED relay ⇒ upstream's official multi-arch image is bit-identical to anything
  we would build: mirrored `ghcr.io/block/buzz:0.2.0` → **`ghcr.io/projectecbr/ecombrain-buzz-relay:0.2.0`**
  (+ `:relay-v0.2.0` alias) via `.github/workflows/mirror-relay-image.yml` (Actions GITHUB_TOKEN —
  no PAT needed; local gh token lacks `write:packages`, no GitHub web session exists in Chrome).
- Package is **private** by default → Task 5 must either make it public or configure CF Containers
  registry credentials (OPEN ITEM).
- Inherited upstream workflows (docker.yml, ci.yml, release.yml, helm-chart.yml, benchmark, sprig,
  auto-tag) **disabled on the fork** to prevent accidental publishes; re-enable ci.yml when the
  fork-sync conformance gate is built (Phase 1).
- Image smoke (Step 3): amd64 image under qemu on Colima, env → compose postgres/redis/minio via
  host.docker.internal, boots, passes its own A3 git conformance probe, readiness OK, and a full
  `buzz-cli` channel+message roundtrip against the container (event 029a63ea…0a79c).
