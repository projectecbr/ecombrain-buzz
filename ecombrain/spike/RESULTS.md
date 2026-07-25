# Phase 0 spike — RESULTS (live document)

Pin: relay-v0.2.0 + desktop v0.4.25 @ 0d9be2fde1fc18e57da8f2ca229cc01699867550.
Status: IN PROGRESS — A1/A3/A6 blocked on CF billing (see GO-NOGO.md), local evidence below is final.

| Check | Result | Evidence |
|-------|--------|----------|
| A1 CF Containers always-on | BLOCKED (billing) | account on Workers Free; Containers need Paid ($5/mo) — money-boundary report sent 2026-07-25 |
| A2 Upstash PSUBSCRIBE from container | PASS (protocol + container leg) | `redis-cli psubscribe` over TLS PASS (2026-07-25); relay container booted with staging `REDIS_URL` → "Redis pub/sub connected"; WS roundtrip through tenant host 10/10 delivered p50=268ms p95=365ms (qemu-emulated, remote services — floor, not ceiling). Only remaining leg: from CF's network |
| A3 R2 via rust-s3 | mechanics PASS (MinIO) / R2 leg BLOCKED (billing) | Blossom upload/download byte-identical vs S3 path-style backend; R2-specific SigV4/checksum leg needs the enabled bucket |
| A4 Supabase TCP from container | PASS | `buzz_staging` created; `buzz-admin migrate` applied (40 tables incl. partitioned events/delivery_log, verified via psql); relay container → "Postgres connected" via session pooler; provisioning + event writes landed (community rows visible) |
| A5 bunker signing latency | local leg PASS / edge leg pending | `verify.mjs bench`: local `finalizeEvent` p50=2.2ms p95=2.6ms. Bunker model = edge RTT + ~3ms sign; budget p95 < 300ms leaves ~297ms for RTT — edge RTT measured at Task 6 deploy |
| A6 R2 checksum quirk | BLOCKED (billing) | with A3 |

## Task 4/6 pre-flight against staging-backed relay container (2026-07-25) — ALL PASS

Relay image `ghcr.io/projectecbr/ecombrain-buzz-relay:0.2.0` run locally with `stg_teams` env
(Supabase buzz_staging via pooler, Upstash TLS; S3 pointed at local MinIO for the boot probe):

- `verify.mjs provision`: `POST /operator/communities` NIP-98 → `created`, re-run → `existed`
  (idempotent converge); unprovisioned host → 404 fail-closed. NOTE: NIP-98 has no nonce —
  identical requests within the same second collide in the replay guard (fixed in verify.mjs
  with a 1.1s gap; relevant for the Agent Bridge design later).
- `verify.mjs roundtrip 10`: 10/10 WS deliveries (NIP-42 mandatory — AUTH kind:22242 relay tag
  = `wss://<tenantHost>`), p50 268ms p95 365ms under qemu emulation.
- `verify.mjs media`: 1MB upload → GET sha256-identical; second community `tenant-other…`
  provisioned → cross-tenant GET of the same hash → 404 (sidecar gate PASS); 20MB upload PASS.

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
8. **CF account topology (verified 2026-07-25 via dash as yannis@ecombrain.io):**
   - Personal account `2b4b7eb9…cf45` (kieferyannis@gmail.com): Workers Free, NO zones.
   - **Business account `83d987db…ff4d` (Yannis@ecombrain.io's Account): holds the `ecombrain.io`
     zone (CF nameservers confirmed) — this is the correct deploy target for staging+production.**
     Workers Free as of 2026-07-25 → needs Paid upgrade ($5/mo) + R2 activation ($0/mo);
     no payment method on file (Chrome autofill has one card but no CVC).
   - A third account (Dgac187@gmail.com's) is visible to the business login; NOT used (governance).
   - The personal account's workers.dev subdomain `coveandlinen` will be replaced by the business
     account's subdomain; RELAY_OPERATOR_API_ORIGIN + Doppler values update at Task 5.
9. **A9 video: relay does NOT transcode** (verified 2026-07-25 at the pin): upload path accepts
   `video/mp4` ONLY (`crates/buzz-relay/src/api/media.rs:356`), stores with a minimal sidecar
   (duration only) — "no thumbnail — desktop handles that" (`crates/buzz-media/src/upload.rs:287,469`).
   The spec's "relay-side transcoding replaces desktop transcode" is FALSE at relay-v0.2.0:
   thumbnails/transcodes were desktop-native (`commands/media_transcode.rs`, not ported).
   Buzz-Web consequence: mp4-only uploads (clean rejection otherwise) + client-side poster
   capture (canvas) or no video thumbnails in v1 — decision recorded in Phase 2 Task 4b.
10. **Owner directive 2026-07-25 (Yannis): CLOUDFLARE IS THE LAST STEP.** All CF deploy legs
   (Phase 0 A1 soak, staging deploy, production) are deferred until every CF-free workstream is
   done; if CF is a real blocker at that point the run STOPS and reports — no workarounds, no
   purchases. R2 was activated by the business partner (payment method added); the Workers Paid
   upgrade was NOT completed — an Upgrade click reached the checkout page only, never confirmed,
   no charge, account still on Free as of this note. The $5/mo upgrade + everything else CF-side
   waits for explicit owner/partner action at the end.

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
