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
