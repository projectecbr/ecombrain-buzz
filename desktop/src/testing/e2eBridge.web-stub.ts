// Web-build stub for `@/testing/e2eBridge` (aliased in vite.web.config.ts).
//
// The real bridge is the Playwright e2e mock surface for the Tauri invoke
// layer (it mocks `plugin:websocket|connect`/`send` among ~200 commands).
// E2E tests run against the desktop build; the browser bundle must not ship
// the Tauri command surface at all, so the web config aliases the dynamic
// import in main.tsx here. Keeps `grep plugin:websocket dist-web` at zero.

export function maybeInstallE2eTauriMocks(): void {
  // No-op on web: e2e mocks target the Tauri runtime only.
}
