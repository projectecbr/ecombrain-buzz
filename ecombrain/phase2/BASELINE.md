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
signing (Adapter B), boot-time Tauri glue (item 5) are Tasks 3–5.
