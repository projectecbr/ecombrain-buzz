# Phase 2 BASELINE (branch ecombrain/phase2-client-port, 2026-07-25)

## Baseline typecheck
- `pnpm typecheck` (desktop, tsc --noEmit): **CLEAN, zero errors**. Any error after
  this point is a regression introduced by the port.

## Task 1 state: web build boots, crashes at first Tauri call
- `vite.web.config.ts` + `index.web.html` produce `dist-web/` (`✓ built in 10s`).
- Served via `pnpm vite preview --port 4599`, page title "EcomBrain Teams" renders,
  then the app crashes: `Cannot read properties of undefined (reading 'metadata')`
  and `('transformCallback')` — `@tauri-apps/api` internals (`window.__TAURI_INTERNALS__`
  absent in a browser). 5 page errors, all the same class.

## Runtime breakage inventory (the Task 2–6 work list)
1. **Adapter A (transport)** — `plugin:websocket|connect/send` in `shared/api/relayClientSession.ts`
   + `relayWebSocketClose.ts` + `readOnlyRelayClient.ts`.
2. **Adapter B (identity)** — `invoke("sign_event")` via `signRelayEvent` (tauri.ts:804),
   `tauriIdentity.ts` (get_identity/get_nsec/import_identity/persist_current_identity),
   keychain onboarding flow.
3. **Adapter C (commands)** — `invokeTauri` (tauri.ts:305) entire proxy surface.
4. **Media seams** — `shared/lib/mediaUrl.ts` (proxy port), useMediaUpload native picker,
   FileCard/markdown download+clipboard.
5. **Boot-time crashers to remove/no-op on web** — `UpdaterProvider` (main.tsx, plugin-updater),
   deep-link listeners (app/App.tsx), window-drag/titlebar glue, plugin-notification,
   plugin-opener, plugin-process (RecoveryScreen).
6. **Removals** — huddle (AppShell + 3 consumers), managed agents UI + /agents, projects routes
   (flag-gated), pairing card, mesh-compute settings.

## Bundle (pre-removals)
- `assets/index.web-*.js`: 3,788.51 kB (gzip 1,104.98 kB) — near the 1.5MB gzip budget already;
  removals + lazy-loading must bring headroom. `assets/emacs-lisp-*.js` 779.87 kB (gzip 197.55 kB)
  — shiki language chunk, lazy-load candidate (A10 watch).

## Task 2 state: Adapter A (transport) wired, contract-tested against local relay (2026-07-25)

What changed:
- `desktop/src/platform/transport.browser.ts` (new) — PlatformTransport over browser
  WebSocket semantics. Text frames → plain strings; close/error → `{type:"Close"|"Error"}`
  control frames (same shapes the session layer already handled). Injectable WebSocket
  constructor (node contract test passes `ws`); defaults to globalThis.WebSocket.
  Reconnect/backoff stays in relayClientSession — the adapter is just the wire.
- `desktop/src/platform/transport.tauri.ts` (new) — the existing
  `plugin:websocket|connect/send` + Channel mapping + Close-frame teardown extracted
  behind PlatformTransport with zero behavior change. `invokeFn` injectable for unit tests.
- `desktop/src/platform/types.ts` — transport contract widened: `TransportMessage`
  (string | Close | Error), `send` may return the invoke promise (rejection drives the
  existing reconnect path), `close` takes an optional reason.
- `desktop/src/platform/index.ts` — `getTransport()` wired as a lazy sync proxy over a
  cached dynamic import, branched on `import.meta.env.VITE_PLATFORM` so the minifier drops
  the tauri chunk from dist-web and the browser shim from the desktop bundle.
- `relayClientSession.ts`, `readOnlyRelayClient.ts`, `relayWebSocketClose.ts` — rewired to
  `getTransport()`; no `@tauri-apps/api` imports left in the transport seam. `closeWebSocket`
  keeps its `(id, reason)` signature and now delegates to the transport.
- `vite.web.config.ts` — aliases `@/testing/e2eBridge` to a new no-op
  `src/testing/e2eBridge.web-stub.ts`; the e2e mock surface contains literal
  `plugin:websocket|connect/send` strings and would otherwise ship in dist-web
  (e2e tests run against the desktop build, unaffected).
- `ecombrain/contract-tests/` (new) — node:test contract test driving the real browser
  adapter against ws://localhost:3335 (NIP-42 kind:22242 with relay tag
  ws://localhost:3335, REQ kind 1 → EOSE, EVENT kind 1 → OK + subscription delivery,
  close + reconnect). Deps: ws, nostr-tools. Run: `cd ecombrain/contract-tests && npm test`.

Test evidence:
- Contract test failed before implementation (ERR_MODULE_NOT_FOUND), passes after:
  `✔ browser transport: NIP-42 + REQ/EVENT/EOSE/OK + close + reconnect (~1.4s)`, 1/1 pass.
- `pnpm typecheck` (desktop): CLEAN, zero errors (baseline preserved).
- `pnpm test` (desktop node tests): 2478 pass, 0 fail (platform.test.mjs and
  relayWebSocketClose.test.mjs updated to the new seam).
- `pnpm vite build` (desktop): ✓ built in 5.33s; dist contains lazy
  `transport.tauri-*.js` with `plugin:websocket|connect`.
- `pnpm vite build --config vite.web.config.ts` (web): ✓ built in ~3-6s;
  `grep -r "plugin:websocket" dist-web/` → ZERO matches (no transport.tauri chunk,
  e2eBridge stubbed).

Note: the app still crashes on web past the transport — `invokeTauri` (Adapter C),
boot-time Tauri glue (item 5) are Tasks 4–5.

## Task 3 state: Adapter B (identity/signing) wired, contract-tested against local relay (2026-07-25)

What changed:
- `desktop/src/platform/signer.localkey.ts` (new) — PlatformSigner over
  nostr-tools (`generateSecretKey`/`finalizeEvent`/`getPublicKey`). DEV-ONLY:
  key held in module memory + sessionStorage under
  `ecombrain-teams-dev-identity` (deliberately NOT `buzz-*`). `created_at`
  override supported; `getPublicKey` deterministic per session. Phase 4
  replaces it with the NIP-46 bunker.
- `desktop/src/platform/signer.tauri.ts` (new) — the existing `sign_event`
  invoke behind PlatformSigner, same camelCase args + JSON.parse as the old
  `signRelayEvent` body; `getPublicKey` via `get_identity`. Zero behavior
  change. `invokeFn` injectable.
- `desktop/src/platform/signer.bunker.ts` (new) — PlatformSigner STUB over
  the nostr-tools BunkerSigner shape; constructor takes a bunker URI, methods
  throw `PHASE-4: bunker not available`. NOT exported from index.ts — out of
  both bundles (verified by grep below).
- `desktop/src/platform/index.ts` — `getSigner()` wired with the Task 2 lazy
  static-branch pattern (minifier drops signer.tauri from dist-web,
  signer.localkey from the desktop bundle).
- `shared/api/relaySigning.ts` (new) + `shared/api/tauri.ts` — `signRelayEvent`
  delegates to `getSigner().signEvent` (signature/return identical; all 32
  call sites untouched). `createAuthEvent` now builds its kind:22242
  relay+challenge event through `signRelayEvent` instead of the
  `create_auth_event` invoke — the Rust command built exactly that event with
  the same key, so desktop behavior is identical and the NIP-42 path
  (relayClientSession.ts:763 `handleAuthChallenge`, readOnlyRelayClient.ts:250)
  works on web unchanged. Both functions live in the new `relaySigning.ts`
  (tauri.ts was at its file-size budget) and are re-exported from tauri.ts,
  so no import site changed.
- `shared/api/tauriIdentity.ts` — web branch: `getIdentity()` returns the
  localkey dev identity shaped like Rust `get_identity` (pubkey +
  npub-truncated displayName, lost/locked false); `getNsec()` throws (private
  keys never in the browser beyond the dev signer); `importIdentity` /
  `persistCurrentIdentity` are console.info no-ops returning the dev identity.
- `ecombrain/contract-tests/signer.test.mjs` (new) — kind 1 sign + local
  `verifyEvent`, then NIP-42 kind:22242 against ws://localhost:3335 accepted
  (`["OK", id, true]`). Failed pre-implementation (ERR_MODULE_NOT_FOUND),
  passes after.
- `src/platform/signer.localkey.test.mjs` (new, 5 tests);
  `platform.test.mjs` updated to the wired seam.

Test evidence:
- Contract tests: 3/3 pass (2 signer + 1 transport),
  `cd ecombrain/contract-tests && npm test`.
- `pnpm typecheck` (desktop): CLEAN, zero errors.
- `pnpm test` (desktop node tests): 2484 pass, 0 fail (2478 baseline + 6 new).
- `pnpm vite build` (desktop): ✓ built in 5.41s; lazy `signer.tauri-*.js`
  chunk carries `sign_event`; no localkey/bunker code in dist.
- `pnpm vite build --config vite.web.config.ts` (web): ✓ built in 3.96s;
  `grep -r "sign_event" dist-web/` → 0, `grep -r "create_auth_event"
  dist-web/` → 0, only `signer.localkey-*.js` chunk present,
  `grep -r "PHASE-4: bunker" dist/ dist-web/` → 0.

## Task 4a state: Adapter C (commands) wired for the core domains, contract-tested against local relay (2026-07-25)

Scope: `ecombrain/phase2/command-map.md` (new) inventories every invoke
command reachable from surviving features — 34 core (Task 4a), 70 backlog
(Task 4b, throw `not-ported-yet`), ~80 removed/excluded. The core domains
are ported faithfully from `src-tauri/src/commands/*.rs`: config (4),
channels (15), dms (2), messages (9), feed/search (2), canvas (2).

What changed:
- `desktop/src/platform/commands.browser.ts` (new) — PlatformCommands over
  NIP-98-signed relay REST (`POST /query` filter-array reads, `POST /events`
  signed-event writes). NIP-98 kind:27235 with u/method/payload/nonce tags
  signed via `getSigner().signEvent` (never raw keys); sent unconditionally
  even though staging has BUZZ_REQUIRE_AUTH_TOKEN=false. Ports the Rust
  behavior exactly: `query_relay_all` 500-page until/before_id paging,
  `channel_info/detail/members_from_event` conversions, event builders from
  `events.rs` (kinds 9000-9022, 41010/41012, 9/45001/45003, 40003, 5, 7,
  40100) with the same validations (64KiB content, 50 mentions, pubkey/uuid
  checks, tag-prefix guards), thread-root resolution, keyset cursors,
  `relay returned {status}: {message}` / `relay rejected event: {message}`
  error strings, `response:{json}` ack parsing, RFC-3339-no-millis
  timestamps. Relay URL resolved per call from the active workspace in
  `buzz-workspaces` localStorage (Rust workspace-override precedence), then
  `VITE_RELAY_URL`, then same-origin. Injectable `signer`/`baseUrl`/`fetchFn`
  for the contract test. Kind constants are inlined (not imported from
  `@/shared/constants/kinds`) because bare-node contract tests cannot
  resolve the `@/` alias; relative runtime import uses explicit `.ts`.
- `desktop/src/platform/commands.tauri.ts` (new) — passthrough to
  `@tauri-apps/api` invoke + the `toTauriError` conversion, lifted verbatim
  from the old `invokeTauri` body. Zero desktop behavior change; `invokeFn`
  injectable.
- `desktop/src/platform/index.ts` — `getCommands()` wired with the same
  lazy static-branch pattern (minifier drops commands.tauri from dist-web,
  commands.browser from dist).
- `shared/api/tauri.ts` — `invokeTauri` now delegates to
  `getCommands().call`. SEAM DECISION: rewiring the single choke point
  inside `invokeTauri` (instead of touching every tauri*.ts proxy) is the
  minimal-diff option — all ~72 wrappers and the domain API files
  (channelWindow.ts etc.) keep working unchanged, and desktop behavior is
  identical because commands.tauri reproduces the old body exactly. tauri.ts
  no longer imports `@tauri-apps/api` at all (only a comment mention), so it
  stays Tauri-free for the web bundle and shrinks under its size budget.
- `platform.test.mjs` — updated to the wired seam (getCommands lazy proxy;
  getMedia still not-wired).
- `ecombrain/contract-tests/commands.test.mjs` (new, 8 tests) — drives
  createBrowserCommands against http://localhost:3335: create_channel /
  get_channels / get_channel_details shapes; send_channel_message +
  get_channel_messages_before + get_channel_window + get_event (JSON-string
  result); thread reply root resolution + get_thread_replies; mention →
  get_feed, content → search_messages; open_dm → dm channel, hide_dm →
  unlisted; `not-ported-yet` error contract. Failed pre-implementation
  (ERR_MODULE_NOT_FOUND), passes after.

Test evidence:
- Contract tests: 11/11 pass (1 transport + 2 signer + 8 commands),
  `cd ecombrain/contract-tests && npm test`.
- `pnpm typecheck` (desktop): CLEAN, zero errors.
- `pnpm test` (desktop node tests): 2485 pass, 0 fail (2484 baseline + 1
  net new from the platform.test.mjs split).
- `pnpm vite build` (desktop): ✓ built in 6.45s; lazy
  `commands.tauri-*.js` chunk; `grep -r "not-ported-yet" dist/` → 0.
- `pnpm vite build --config vite.web.config.ts` (web): ✓ built in 2.22s;
  only `commands.browser-*.js` carries the NIP-98 code
  (`grep -rl "not-ported-yet" dist-web/assets` → that chunk only); no
  commands.tauri chunk in dist-web.

Deviations / notes:
- `get_channel_members` does NOT port the NIP-OA owner-tag verification
  that sets `is_agent` from kind:0 profiles (buzz-sdk crypto verify);
  `is_agent` comes from the membership role ("bot") only, display_name is
  populated. Documented in command-map.md.
- `created_by` in channel details is the relay's own pubkey (the relay
  synthesizes kind:39000) — same as the Rust `channel_detail_from_event`;
  the contract test pins the shape, not the creator identity.
- Remaining `@tauri-apps/api` static imports in the web bundle
  (useReconnectRelay, haptics, titleBarActions, useIsFullscreen, mediaUrl)
  are the Task 5 boot-glue items, already inventoried above.
- Task 4b backlog (throws `not-ported-yet: <command>`): profiles/presence
  (6), relay members/agents (6), social/notes (8), contacts (2), forum (2),
  workflows (11), personas (8), teams (9), channel templates (5),
  apply_workspace (1), nip44 to-self (2, via PlatformSigner extension),
  media commands (8, move to the PlatformMedia seam), misc native (2).
  Full per-command table in ecombrain/phase2/command-map.md.
