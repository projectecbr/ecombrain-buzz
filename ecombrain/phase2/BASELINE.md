# Phase 2 Baseline — Buzz-Web client port

Recorded 2026-07-25 on branch `ecombrain/phase2-client-port` (forked from
`ecombrain/phase0-spike`), after Task 1 (platform skeleton + web build).

## Toolchain / test baselines

- Hermit env active (`bin/activate-hermit`): node v24.14.0, pnpm 11.4.0.
- `pnpm typecheck` (desktop, `tsc --noEmit`): **0 errors** (clean). Any error
  from here on is a NEW regression.
- `pnpm test` (desktop, node test runner + test-loader.mjs): **2476 pass /
  0 fail** (includes the 3 new `src/platform/platform.test.mjs` tests).

## Task 1 deliverables

- `desktop/src/platform/types.ts` — `PlatformTransport`, `PlatformSigner`,
  `PlatformCommands`, `PlatformMedia` (+ `TransportHandle`, `SignEventInput`,
  `UploadResult`). `RelayEvent` reused from `shared/api/types.ts` (Tauri-free);
  `UploadResult` mirrors `BlobDescriptor` from `shared/api/tauri.ts` without
  importing it (tauri.ts pulls in `@tauri-apps/api`).
- `desktop/src/platform/index.ts` — `getPlatform()` (`'web'` when
  `import.meta.env.VITE_PLATFORM === 'web'`, else `'tauri'`), lazy factories
  `getTransport()/getSigner()/getCommands()/getMedia()` throwing
  `not wired yet`, plus `__setPlatformOverrideForTests` seam for the node
  test runner (which has no `import.meta.env`).
- `desktop/src/platform/platform.test.mjs` — 3 tests, green. (Named `.mjs`
  per repo convention: the `pnpm test` glob is `src/**/*.test.mjs`; a `.ts`
  test file would never run.)
- `desktop/vite.web.config.ts` — same tanstackRouter + react plugins and
  aliases as `vite.config.ts`, `define: import.meta.env.VITE_PLATFORM='"web"'`,
  `build.outDir: 'dist-web'`, input `index.web.html`, no Tauri dev-server/HMR
  block, plus a small `closeBundle` plugin copying `index.web.html` →
  `index.html` (Vite names the HTML output after the source basename; static
  hosts and `vite preview` serve `/` from `index.html`).
- `desktop/index.web.html` — copy of `index.html` with
  `<title>EcomBrain Teams</title>` and an empty inline-SVG data-URI favicon
  (no Buzz bee).

Verified in the built bundle: `getPlatform()` constant-folds to `"web"`
(define replacement works through the `import.meta.env?.VITE_PLATFORM`
optional chain).

## Web build result

`pnpm vite build --config vite.web.config.ts` → **builds clean** in ~8–18s.
Expected warnings only: chunk-size hints and INEFFECTIVE_DYNAMIC_IMPORT notes
(`@tauri-apps/api/event`, `shared/api/tauri.ts`, `sonner`, …).

- Entry: `dist-web/index.html` + `dist-web/index.web.html` (identical)
- Main chunk: `assets/index.web-*.js` — 3,788,515 B (**gzip 1,093,755 B ≈ 1.07 MiB**)
- Main CSS: `assets/index-*.css` — 305,382 B (gzip 43,037 B)
- Initial total ≈ **1.11 MB gzip — inside the 1.5 MB budget** (Task 7 tracks this).
- Notable lazy chunks: `e2eBridge` 117 kB, `AgentsView` 113 kB, shiki language
  packs, `@mediapipe` vision bundle 135 kB — all candidates for Task 5/7
  tree-shaking.
- `vite preview --config vite.web.config.ts --port 4599` serves `/` (200,
  correct title/favicon), the JS bundle, and SPA-fallback routes (200).

## Runtime breakage inventory (the Tasks 2–6 work list)

Probe: `ecombrain/phase2/runtime-probe.cjs` (Playwright + system Chrome,
headless) against the preview server. Result: **the React tree crashes during
initial render — `#root` stays empty (black page)**. 5 uncaught page errors,
2 console warnings, 0 failed network requests.

1. **`@tauri-apps/api` `invoke` unavailable** — `TypeError: Cannot read
   properties of undefined (reading 'invoke')` (`window.__TAURI_INTERNALS__`
   is undefined in a browser). First hits: legacy workspace storage read and
   `is_shared_identity` command during boot. → **Task 4 (Adapter C:
   `invokeTauri` → `getCommands().call`)**.
2. **`transformCallback` undefined** (4 of 5 uncaught errors) —
   `@tauri-apps/api` event/Channel internals invoked during render (event
   listeners, websocket `Channel`, updater checks). → **Task 2 (Adapter A:
   transport Channel seam)** and **Task 5 step 6 (updater/listener glue)**.
3. **`metadata` undefined** (1 of 5) — Tauri window/app metadata read during
   provider mount (window chrome / updater path). → **Task 5 step 6 (OS glue
   removal: UpdaterProvider, title-bar/window hooks)**.
4. **App boots to a blank page**, not even the loading gate — the crash
   happens inside provider render, before any route screen. Until Task 6
   (handoff bootstrap) lands there is no identity path anyway; onboarding
   calls keyring commands (`get_identity`, …) that all throw per (1).
5. **Tauri code in the bundle**: `@tauri-apps/*` code present in ≥5 emitted
   chunks (incl. the main chunk and `SettingsScreen`, `ProjectsScreen`,
   `ChannelRouteScreen`, `ProjectDetailScreen` lazy chunks). Task 5 step 7
   gate: `grep -r "@tauri-apps" dist-web/assets/*.js | wc -l` → 0.
6. **`buzz://` deep-link scheme** still referenced in app code
   (`shared/deep-link.ts`, listeners in `app/App.tsx`). Web deep links are
   plain URLs. → **Task 5 step 6**; gate `grep -rn "buzz://" dist-web` → 0.
7. **Buzz brand assets copied into `dist-web/`** from `public/`:
   `buzz.svg` (bee), `app-icon@2x.png`, `app-icon@3x.png`. The web HTML does
   not reference them (favicon is an empty data URI), but they ship in the
   directory. → strip/replace in **Phase 3 branding** (mechanical removals
   allowed in Task 5 if desired).
8. **localStorage keys still `buzz-*`** (`buzz-theme-cache` read by the boot
   inline script, etc.) → Phase 3 rename to `ecombrain-teams-*`.

## Deviations from the Task 1 brief

- Test file is `platform.test.mjs`, not `platform.test.ts` — the repo's test
  glob only matches `*.test.mjs` (see `desktop/package.json` "test" script).
- `PlatformMedia.pickAndUpload()` returns `Promise<UploadResult[]>` (array),
  matching the real `pick_and_upload_media` command (`BlobDescriptor[]`),
  not the singular `Promise<UploadResult>` sketched in the brief.
- `vite.web.config.ts` adds a tiny `emitIndexHtml()` plugin copying
  `index.web.html` → `index.html` post-build so `/` serves on static hosts;
  the rollup `input: { index: ... }` key trick does not rename HTML output.
- Bundle ships `buzz.svg` / `app-icon*.png` in `dist-web/` (copied from
  `public/`); unreferenced by the web HTML, removal deferred to Phase 3 per
  the plan's branding rule.
