# Desktop client codebase map (verified 2026-07-25 @ relay-v0.2.0 / v0.4.25)

Source: explorer report over branch `ecombrain/phase0-spike`. Referenced by
`phase-2-client-port.md` (product repo, docs/superpowers/plans/2026-07-25-buzz-teams-fork/).

## Entry + routing
- `desktop/package.json`: react 19.1, @tanstack/react-router ^1.168, react-query, tauri plugins
  (notification, opener, process, updater), tiptap, zod, shiki, radix, nostr-tools ^2.23.3
  (devDep but imported by app code — reusable for browser signing).
- `desktop/vite.config.ts`: tanstackRouter plugin (`routesDirectory: ./src/app/routes`,
  `virtualRouteConfig: ./src/app/routes.ts`), alias `@`→/src, `@features-manifest`→../preview-features.json,
  Tauri HMR block + strictPort 1420 (web-harmless), no `base` override.
- Routes (virtual, `app/routes.ts`): `/`, `/agents`, `/pulse`, `/reminders`, `/settings`,
  `/workflows`, `/workflows/$workflowId`, `/projects`, `/projects/$projectId`,
  `/channels/$channelId`, `/channels/$channelId/posts/$postId`.
- Router: `app/router.tsx` — `createHashHistory()` (browser-safe as-is).
- Entry: `main.tsx` → `app/App.tsx` (WorkspacesProvider, ThemeProvider default "houston",
  UpdaterProvider, NostrBindConsentDialog, Toaster) → `app/AppShell.tsx` (+Overlays/+TopChrome).

## Transport seam (Adapter A)
- `shared/api/relayClientSession.ts` (1019 lines) — `export class RelayClient`; singleton in
  `shared/api/relayClient.ts`.
  - `:523` `invoke<number>("plugin:websocket|connect", { url, onMessage: Channel, config: {} })`
  - `:608` `invoke("plugin:websocket|send", { id, message: { type: "Text", data } })`
  - close: `shared/api/relayWebSocketClose.ts`
  - NIP-42 in-session: `handleAuthChallenge` → `createAuthEvent` (:780); reconnect/backoff,
    stall watchdog, live-sub replay (`relayReconnectReplay.ts`).
- Second client: `shared/api/readOnlyRelayClient.ts` (same WS-plugin pattern, `createAuthEvent` :262).
- Port: swap `plugin:websocket|connect/send/close` + `Channel` for browser WebSocket; everything
  above the seam is transport-agnostic.

## Commands seam (Adapter C)
- Choke point: `invokeTauri<T>(command, args)` — `shared/api/tauri.ts:305`.
- Proxy files in `shared/api/`: tauri.ts (1270 lines, 72 invokes: channels/dms/messages/canvas/
  feed/search/relay members/managed agents/media/pairing/identity-adjacent), tauriArchive.ts (13),
  tauriWorkflows.ts (13), tauriPersonas.ts (9), tauriMesh.ts (11), tauriTeams/tauriProfiles/
  tauriChannelTemplates (~120 lines each), tauriIdentity.ts (4: get_identity, get_nsec,
  import_identity, persist_current_identity), tauriIdentityArchive.ts (4), tauriManagedAgents/
  ManagedAgentMessages/GlobalAgentConfig/Media/Observer/Engrams (small).
- Domain APIs calling invoke directly: projectGit.ts, agentControl.ts, agentModels.ts,
  channelWindow.ts, forum.ts, invites.ts, moderation.ts, relayMembers.ts, social.ts,
  customEmoji.ts, workspaceProfile.ts.
- Example: `sendChannelMessage(...) → invokeTauri("send_channel_message")` (tauri.ts:691);
  `signRelayEvent(input) → invokeTauri<string>("sign_event")` then JSON.parse (tauri.ts:804).
- Rust registry: `src-tauri/src/lib.rs:551` (`tauri::generate_handler!`, ~200 commands);
  per-domain `src-tauri/src/commands/*.rs`.
- JS reference impl of the whole surface: `desktop/src/testing/e2eBridge.ts` (e2e mocks).

## Identity seam (Adapter B)
- Rust: `src-tauri/src/commands/identity.rs` (16 commands incl. `sign_event` :82,
  `create_auth_event`, `get_nsec`, `import_identity`, nip44 helpers) + `identity_archive.rs` (4).
  Secret storage: `src-tauri/src/secret_store.rs` (OS keyring; SecKeychain on macOS).
- Frontend: `shared/api/tauriIdentity.ts` (4 wrappers); `useIdentityQuery` (`shared/api/hooks.ts:5`).
- Signing: everything via `signRelayEvent` (tauri.ts:804); 32 call sites, concentrated in
  relayClientSession.ts (4), moderation.ts (3), invites/relayMembers/customEmoji/workspaceProfile,
  readStateManager (2), sidebar channel sync (4), reminderService (4), projects/hooks (3),
  pullRequestReviews, HuddleBar.
- Keyring UX: features/onboarding/hooks.ts (`keyring-locked` stage), KeyringLockedScreen,
  RecoveryScreen (plugin-process relaunch).

## Removals (exact mount points)
- Huddle (4 render consumers + shell): `app/AppShell.tsx:63,643,909` (HuddleProvider/HuddleBar);
  `features/channels/ui/ChannelMembersBar.tsx:4-6,111`; `features/profile/ui/UserProfilePopover.tsx:7,184,695`;
  `features/messages/ui/WaveMessageAttachment.tsx:6,31`; `relayClientSession.ts:365`
  (subscribeToHuddleEvents); `features/huddle/` dir; `--huddle-*` vars in globals/theme.css.
  Not behind a flag — mounted unconditionally.
- Managed agents: `features/agents/ui/` (ManagedAgentRow/SessionPanel/LogPanel, AgentConfigPanel,
  AgentDefinitionDialog, AgentInstanceEditDialog, useManagedAgentActions, managedAgentAvatar);
  `/agents` route (`app/routes/agents.tsx` → AgentsScreen); sidebar nav ("agents",
  `features/sidebar/ui/AppSidebar.tsx:98`); profile panel sections; `AgentSessionThreadPanel`.
- Projects (git/terminal): `features/projects/ui/`, routes `/projects*` — behind
  `usePreviewFeatureWarning("projects")` (preview-features.json). API `shared/api/projectGit.ts`.
- Pairing: `features/settings/ui/MobilePairingCard.tsx` mounted `SettingsPanels.tsx:60,663`.
- Mesh-LLM: `features/mesh-compute/` (MeshComputeSettingsCard, RelayMeshAgentSection,
  useMeshNodeStatus/useMeshAvailability/applyMeshAgentPreset) mounted `SettingsPanels.tsx:59,649`
  + `features/agents/ui/WhereToRunSection.tsx`.
- Updater: `features/settings/hooks/UpdaterProvider.tsx` (main.tsx), use-updater.ts,
  UpdateChecker/UpdateIndicator/SidebarUpdateCard (`AppSidebar.tsx:50,233`,
  `SettingsPanels.tsx:665`); `isAutoUpdateSupported` (tauri.ts:1268).
- Deep links: `shared/deep-link.ts` (`listenForDeepLinks` in `app/App.tsx:29,357`),
  `shared/useMessageDeepLinks.ts`; protocol `buzz://connect|join|message|nostr-bind`.
- **"Builderlab": does not exist at this pin (spec deviation — zero matches).**

## Media call sites
- Upload: `features/messages/lib/useMediaUpload.ts:5-6,377,414,511,540,580`
  (`pick_and_upload_media`, `upload_media`, `upload_media_bytes`); ComposerImageEditor;
  `features/profile/useAvatarUpload.ts:4,56`; AnimatedAvatarCapture; CustomEmojiSettingsCard;
  managedAgentAvatar.ts:46.
- Download: `shared/ui/markdown/FileCard.tsx:50` (`download_file`); `shared/ui/markdown.tsx:1428`
  (`download_image`).
- Clipboard: `shared/ui/markdown.tsx:1414` (`copy_image_to_clipboard`); text copy already
  navigator.clipboard (13 sites).
- Serving: `shared/lib/mediaUrl.ts` polls `get_media_proxy_port` (Rust localhost proxy) →
  web must use relay HTTP directly.
- Transcode: Rust-only, no TS call sites (nothing to port).

## Tauri import surface (30 files, top entries)
1. features/notifications/lib/desktop.ts (4 — plugin-notification → Web Notifications API)
2. features/settings/hooks/use-updater.ts (2)
3-4. features/huddle/HuddleContext.tsx, HuddleBar.tsx (removed anyway)
5. testing/e2eBridge.ts (mock surface, e2e only)
6. shared/theme/ThemeProvider.tsx (1 — window theme listener; no-op on web)
7. shared/lib/mediaUrl.ts (1)
8. titleBarActions/useTauriWindowDrag/useWebviewZoomShortcuts/StartupWindowDragRegion (no-op)
9. relayClientSession.ts, readOnlyRelayClient.ts, relayWebSocketClose.ts (Adapter A)
10. shared/api/tauri.ts (invokeTauri choke point)
Plus plugin-opener openUrl in 6 files (→ window.open); plugin-process relaunch in
RecoveryScreen + use-updater (→ location.reload()).

## web/ directory (repo root)
Existing browser app `buzz-web` v0.1.0 (Vite+React19+TanStack+Tailwind v4, NO Tauri deps):
routes `/`, `/repos`, `/repos/$repoId/blob/$`, `/invite/$code`; in-browser git via isomorphic-git;
nostr-client.ts/nip98.ts/relay-url.ts in shared/lib. Reference for browser relay access patterns
(NOT the Teams design source — desktop is, per D4).

## Branding (Phase 3 pointers)
- Tokens: `desktop/src/shared/styles/globals/theme.css` (HSL vars, Catppuccin Latte/Macchiato),
  engine `shared/theme/` (adaptive-theme.ts, theme-loader.ts registry, ThemeProvider);
  mapping `desktop/tailwind.config.js`; font Inter Variable (@fontsource-variable/inter, main.tsx).
- Logo: `desktop/public/buzz.svg` (favicon, index.html:5), `app-icon@2x/3x.png` (WelcomeSetup),
  native icons `src-tauri/icons/`.
- "Buzz" strings: tauri.conf.json productName, onboarding screens, `buzz://` scheme,
  localStorage keys `buzz-*` (main.tsx:22,43). index.html `<title>` empty (set dynamically).
