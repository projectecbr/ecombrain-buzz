# Phase 2 Task 4 — invoke command map (Adapter C)

Every `invoke` command reachable from features that **survive** the Phase 2
removals, grouped by domain, with the frontend wrapper, a 1-liner of the Rust
behavior, and the browser strategy. Commands in removed features are listed
at the end for completeness (they are deleted, not ported).

Wire facts (verified against `src-tauri/src/relay.rs` and `commands/*.rs`):

- Reads: `POST {relay-http}/query`, body = JSON array of nostr filters,
  response = JSON array of raw nostr events.
- Writes: `POST {relay-http}/events`, body = the signed event JSON,
  response = `{ event_id, accepted, message }`; `accepted:false` → error
  `relay rejected event: {message}`; non-2xx → `relay returned {status}: {message}`
  (message/error field from JSON body, else bare status). Command kinds ack
  via `message = "response:{json}"` (see `parse_command_response`).
- Auth: NIP-98 kind:27235, tags `u` (full URL), `method`, `payload`
  (sha256-hex of body), `nonce` (uuid — avoids same-second replay-id
  collisions), sent as `Authorization: Nostr <base64(event-json)>`.
  Signed via the platform signer (`getSigner().signEvent`), never raw keys.
- The relay p-gate (`P_GATED_KINDS` = 24200, 44100, 44101, 1059, 30622,
  44200) requires `#p` == authed pubkey on filters that could match those
  kinds; kindless filters are rejected outright — every filter below carries
  explicit `kinds`.
- Relay event JSON shape (`/query` rows) matches `RelayEvent`
  (`shared/api/types.ts`): `{id, pubkey, created_at, kind, tags, content, sig}`.
- ISO timestamps use Rust `timestamp_to_iso`: `YYYY-MM-DDTHH:MM:SSZ`
  (no millis).
- Reference JS impl of most of this surface (e2e, `X-Pubkey` auth instead of
  NIP-98): `desktop/src/testing/e2eBridge.ts`.

Browser strategies used below:
- **REST** — NIP-98-signed `/query` + `/events` port of the Rust command.
- **CLIENT** — resolved client-side (workspace localStorage / no-op).
- **WS** — live subscription via `relayClientSession` (already on Adapter A).
- **MEDIA** — `PlatformMedia` seam (Blossom PUT/GET), not Adapter C.
- **SIGNER** — extend `PlatformSigner` (localkey now, NIP-46 bunker Phase 4).

---

## CORE (Task 4a — implemented in `platform/commands.browser.ts`)

### config / relay URL (tauri.ts) — CLIENT
| command | wrapper | Rust behavior | strategy |
|---|---|---|---|
| `get_relay_ws_url` | `getRelayWsUrl` (tauri.ts:412) | workspace override > env > build default | CLIENT: active workspace `relayUrl` from `buzz-workspaces` localStorage, else `VITE_RELAY_URL`, else same-origin |
| `get_relay_http_url` | `getRelayHttpUrl` (tauri.ts:416) | same, ws→http (wss→https, ws→http) | CLIENT: same resolution + `relay_http_base_url` conversion |
| `get_default_relay_url` | `getDefaultRelayUrl` (tauri.ts:404) | default relay URL (no workspace override) | CLIENT: `VITE_RELAY_URL` ?? same-origin |
| `is_shared_identity` | `isSharedIdentity` (tauri.ts:408) | true when `BUZZ_SHARE_IDENTITY=1` + `BUZZ_PRIVATE_KEY` set | CLIENT: constant `false` on web |

### channels (tauri.ts; Rust `commands/channels.rs`) — REST
| command | wrapper | Rust behavior | strategy |
|---|---|---|---|
| `get_channels` | `getChannels` (tauri.ts:420) | 39002 `#p`=me → d-tags; 39000 `#d`=ids + all open 39000 (paged 500 w/ `until`+`before_id`); merge `is_member`; member_count/pubkeys from batched 39002; `last_message_at` from per-channel kinds [9,40002] `#h` limit 1; drop DMs hidden in kind:30622 (`#p`=me) | REST (ported in full) |
| `create_channel` | `createChannel` (tauri.ts:425) | kind:9007 (h=uuid, name, visibility, channel_type, about?, ttl?) → re-query 39000 `#d` → ChannelInfo | REST |
| `get_channel_details` | `getChannelDetails` (tauri.ts:439) | 39000 `#d` limit 1 → ChannelDetailInfo (`created_by`=event pubkey, `created_at`/`updated_at`=iso(created_at), topic/purpose `_set_by/at` null, member_count 0) | REST |
| `get_channel_members` | `getChannelMembers` (tauri.ts:448) | 39002 `#d` limit 1 → members from p-tags (`role`=tag[3]??"member", `is_agent`=role=="bot"), then kind:0 batch for `display_name` (+OA-owner agent flag) | REST — display_name ported; NIP-OA owner verify **not** ported (is_agent from role only; see Deviations) |
| `update_channel` | `updateChannel` (tauri.ts:460) | kind:9002 (h + name?/about?/visibility?/ttl?; ttl null → `["ttl",""]` clears) → re-query 39000 → ChannelDetailInfo | REST |
| `set_channel_topic` | `setChannelTopic` (tauri.ts:469) | kind:9002 (h, topic) | REST |
| `set_channel_purpose` | `setChannelPurpose` (tauri.ts:475) | kind:9002 (h, purpose) | REST |
| `archive_channel` | `archiveChannel` (tauri.ts:481) | kind:9002 (h, archived=true) | REST |
| `unarchive_channel` | `unarchiveChannel` (tauri.ts:485) | kind:9002 (h, archived=false) | REST |
| `delete_channel` | `deleteChannel` (tauri.ts:489) | kind:9008 (h) | REST |
| `add_channel_members` | `addChannelMembers` (tauri.ts:493) | per-pubkey kind:9000 (h, p, role?) → `{added, errors[]}`; role validate admin/bot/guest/member | REST |
| `remove_channel_member` | `removeChannelMember` (tauri.ts:499) | kind:9001 (h, p) | REST |
| `change_channel_member_role` | `changeChannelMemberRole` (tauri.ts:505) | kind:9000 (h, p, role); rejects "owner" | REST |
| `join_channel` | `joinChannel` (tauri.ts:514) | kind:9021 (h) | REST |
| `leave_channel` | `leaveChannel` (tauri.ts:518) | kind:9022 (h) | REST |

### dms (tauri.ts; Rust `commands/dms.rs`) — REST
| command | wrapper | Rust behavior | strategy |
|---|---|---|---|
| `open_dm` | `openDm` (tauri.ts:431) | kind:41010 (p-tags, 64-hex validated) → parse `response:{channel_id}` → re-query 39000 → ChannelInfo | REST |
| `hide_dm` | `hideDm` (tauri.ts:435) | kind:41012 (h) | REST |

### messages (tauri.ts; Rust `commands/messages.rs`) — REST
| command | wrapper | Rust behavior | strategy |
|---|---|---|---|
| `send_channel_message` | `sendChannelMessage` (tauri.ts:691) | kind 9 (default)/45001/45003; h-tag + NIP-10 thread tags (parent fetched, root/reply markers walked) + p/imeta/emoji/mention tags (prefix-validated, 64KiB cap, ≤50 mentions); returns `{event_id, parent_event_id, root_event_id, depth, created_at}` | REST |
| `edit_message` | `editMessage` (tauri.ts:766) | kind:40003 (h, e, imeta, emoji); empty content allowed only with imeta | REST |
| `delete_message` | `deleteMessage` (tauri.ts:782) | kind:5 (h, e) | REST |
| `add_reaction` | `addReaction` (tauri.ts:789) | kind:7 (e; content=emoji, ≤64 chars); custom emoji adds NIP-30 `["emoji", shortcode, url]` | REST |
| `remove_reaction` | `removeReaction` (tauri.ts:797) | query own kind:7 `#e`+authors=me matching content → kind:5 delete it | REST |
| `get_event` | `getEventById` (tauri.ts:581) | `/query` ids + kind allowlist, limit 1 → **JSON string** of the event | REST (returns string, wrapper JSON.parses) |
| `get_thread_replies` | `getThreadReplies` (tauri.ts:612) | filter `#e`=root + TIMELINE_KINDS (p-gate!) + `depth_limit` (default 64) + limit (default 200, max 500) + `#h`? + `thread_cursor`/`thread_cursor_id`?; `next_cursor` from last event on full page | REST |
| `get_channel_messages_before` | `getChannelMessagesBefore` (tauri.ts:665) | filter `#h` + TIMELINE_KINDS + `until` + `before_id`? + limit (default 200, max 500); `next_cursor` = oldest on full page | REST |
| `get_channel_window` | `getChannelWindowEvents` (channelWindow.ts:5) | filter `#h` + TIMELINE_KINDS + `top_level`/`include_summaries`/`include_aux` true + `until`/`before_id`? + limit (default 50, max 200) → raw event array | REST |

TIMELINE_KINDS = [9, 40002, 40008, 40099, 43001–43006, 48100] (11 kinds;
identical in messages.rs and channel_window.rs).

### feed / search (tauri.ts; Rust `commands/messages.rs`) — REST
| command | wrapper | Rust behavior | strategy |
|---|---|---|---|
| `get_feed` | `getHomeFeed` (tauri.ts:546) | mentions: kinds [9,40002,1,45001,45003] `#p`=me limit cap(50→100) (+since); needs_action: kinds [46010,46011,46012] `#p`=me limit 20 (+since); `types` comma-filter; activity/agent_activity empty; meta `{since: since??0, total, generated_at: now}` | REST |
| `search_messages` | `searchMessages` (tauri.ts:566) | kinds [9,40002,45001,45003] + `search`=q.trim() + `search_mode`="prefix" + limit cap(20→100) + `#h`?; score = 1 − idx/total (1.0 when ≤1 hit) | REST |

### canvas (tauri.ts; Rust `commands/canvas.rs`) — REST (cheap, folded into 4a)
| command | wrapper | Rust behavior | strategy |
|---|---|---|---|
| `get_canvas` | `getCanvas` (tauri.ts:522) | kinds [40100] `#h` limit 1 → `{content:""}` or `{content, event_id, created_at, pubkey}` | REST |
| `set_canvas` | `setCanvas` (tauri.ts:533) | kind:40100 (h; content) → `{ok:true, event_id}` | REST |

---

## TASK 4b (browser adapter throws `not-ported-yet: <command>` until then)

### profiles / presence (tauriProfiles.ts, tauri.ts) — REST
- `get_profile` — kind:0 for me → ProfileInfo (`has_profile_event` flag).
- `get_user_profile` / `get_users_batch` — kind:0 by authors (batch).
- `search_users` — kinds [0] + `search` (+paging).
- `update_profile` — read-merge-write kind:0.
- `get_presence` (tauri.ts:391) — per-pubkey latest kind:30315 → PresenceLookup (keys lowercased).

### relay members / agents (tauri.ts) — REST
- `list_relay_members` / `get_my_relay_membership` — relay membership read (404 → null contract in wrapper).
- `add_relay_member` / `remove_relay_member` / `change_relay_member_role` — relay REST admin writes (check Rust `relay_members.rs` for exact path).
- `list_relay_agents` — kind:10100 `/query` → RawRelayAgent[].

### social / notes (social.ts) — REST
- `get_user_notes`, `get_global_notes`, `get_notes_timeline`, `get_note`,
  `get_note_reactions`, `get_liked_notes`, `publish_note` — kind:1-centered
  `/query` + `/events` (see Rust `social*.rs`).

### contacts (social.ts) — REST
- `get_contact_list` / `set_contact_list` — kind:3 read / read-merge-write.

### forum (forum.ts) — REST
- `get_forum_posts` — kinds [45001] `#h` + until paging → ForumMessageInfo.
- `get_forum_thread` — root by id + replies `#e` (kinds 9/45003) → ForumThreadResponse.

### workflows (tauriWorkflows.ts) — REST
- `create_workflow`, `update_workflow`, `delete_workflow`, `get_workflow`,
  `get_channel_workflows`, `get_channels_workflows` — kind:30620 (d=workflow id,
  h=channel) replaceable defs.
- `trigger_workflow`, `get_workflow_runs`, `get_run_approvals`,
  `grant_approval`, `deny_approval` — 460xx command/approval kinds.

### personas / teams / channel templates — REST + LOCAL-FILE (defer file ops)
- Personas (tauriPersonas.ts): `list_personas`, `create_persona`,
  `update_persona`, `delete_persona`, `set_persona_active`,
  `reconcile_inbound_persona_event` — local store + kind:30175 projection;
  `export_persona_to_json` (→ `<a download>`), `parse_persona_files` (native
  file read — needs `<input type=file>` UX change or defer).
- Teams (tauriTeams.ts): `list_teams`, `create_team`, `update_team`,
  `delete_team`, `export_team_to_json` — local store + kind:30176;
  `install_team_from_directory`, `pick_team_directory`,
  `sync_team_directory`, `parse_team_file` — native FS, **defer**
  (no browser equivalent without File System Access API).
- Channel templates (tauriChannelTemplates.ts): `list/create/update/delete/
  duplicate_channel_template` — local store; port to IndexedDB/localStorage
  or relay event, decide in 4b.

### workspace (tauri.ts) — CLIENT
- `apply_workspace` — Rust persists workspace + optionally imports nsec into
  keychain. Web: localStorage write only (nsec/token args unsupported —
  identity comes from the signer seam).

### encryption-to-self (tauri.ts) — SIGNER
- `nip44_encrypt_to_self` / `nip44_decrypt_from_self` — used by surviving
  sidebar sync (channelSort/Sections/Mutes/Stars). Extend `PlatformSigner`:
  localkey via nostr-tools `nip44.v2` (conversation key to own pubkey);
  bunker via NIP-46 `nip44_encrypt/decrypt`.

### media (tauri.ts, tauriMedia.ts + direct invoke call sites) — MEDIA seam
Not Adapter C: handled by `PlatformMedia` (getMedia) per desktop-map
"Media call sites". commands.browser keeps throwing until call sites rewire:
- `pick_and_upload_media`, `upload_media`, `upload_media_bytes`
  (useMediaUpload/useAvatarUpload/ComposerImageEditor/CustomEmojiSettingsCard)
  — Blossom `PUT /media/upload` (kind:24242 auth, `X-SHA-256`).
- `fetch_media_bytes` (tauriMedia.ts) — `GET /media/{sha256}` + blob.
- `download_file` (FileCard.tsx:50), `download_image` (markdown.tsx:1428),
  `copy_image_to_clipboard` (markdown.tsx:1414), `get_media_proxy_port`
  (mediaUrl.ts) — direct-invoke call sites; rewire to `getMedia()`
  (`<a download>`, `navigator.clipboard`, relay HTTP URLs).

### misc native — CLIENT no-op / drop
- `set_prevent_sleep_active` — native wakelock; no-op on web (or
  `navigator.wakeLock`, decide in 4b).
- `fetch_workspace_icon` — Rust-side HTTP fetch (CORS bypass); web: direct
  `fetch`, accept CORS limits.

---

## REMOVED / EXCLUDED (deleted with their features — NOT ported)

- **Managed agents** (features/agents, tauriManagedAgents.ts,
  tauriManagedAgentMessages.ts, tauriGlobalAgentConfig.ts, tauriEngrams.ts,
  agentControl.ts, agentModels.ts, tauri.ts agent sections):
  `list_managed_agents`, `create_managed_agent`, `update_managed_agent`,
  `delete_managed_agent`, `start_managed_agent`, `stop_managed_agent`,
  `set_managed_agent_start_on_app_launch`, `set_managed_agent_auto_restart`,
  `get_managed_agent_log`, `send_managed_agent_channel_message`,
  `discover_acp_providers`, `install_acp_runtime`,
  `discover_managed_agent_prereqs`, `get_agent_models`,
  `get_agent_config_surface`, `put_agent_session_config`,
  `get_runtime_file_config`, `get_baked_build_env_keys`,
  `get_baked_build_env`, `discover_backend_providers`,
  `probe_backend_provider`, `get_global_agent_config`,
  `set_global_agent_config`, `discover_agent_models`, `cancel_turn`,
  `switch_model`, `get_agent_memory`.
- **Huddle** (features/huddle): `start_huddle`, `join_huddle`, `leave_huddle`,
  `end_huddle`, `get_huddle_state`, `confirm_huddle_active`,
  `get_huddle_agent_pubkeys`, `set_huddle_transcription_enabled`,
  `set_tts_enabled`, `speak_agent_message`, `get_audio_output_device`,
  `set_audio_output_device`, `get_voice_input_mode`, `set_voice_input_mode`,
  `check_pipeline_hotstart`.
- **Project git/terminal** (projectGit.ts, agentControl.ts):
  `get_project_repo_snapshot`, `get_project_local_repo_snapshot`,
  `get_project_repo_diff`, `get_project_local_repo_diff`,
  `get_project_repo_sync_status`, `list_project_local_repositories`,
  `push_project_local_repository`, `open_project_terminal`,
  `get_git_identity`, `validate_repos_dir`.
- **Pairing** (MobilePairingCard): `start_pairing`, `confirm_pairing_sas`,
  `cancel_pairing`.
- **Mesh** (tauriMesh.ts): `mesh_availability`, `mesh_installed_models`,
  `mesh_node_status`, `mesh_start_node`, `mesh_stop_node`,
  `mesh_ensure_client_node`, `mesh_prepare_relay_mesh_client`,
  `mesh_dial_endpoint_addr`, `mesh_status_report_payload`,
  `mesh_agent_preset`.
- **Updater** (removed Task 5): `is_auto_update_supported`.
- **Identity keychain** (tauriIdentity.ts — already on the Task 3 signer/identity
  seam, not Adapter C): `get_identity`, `get_nsec`, `import_identity`,
  `persist_current_identity`. Also already off invoke: `sign_event`,
  `create_auth_event` (→ `relaySigning.ts` → `getSigner()`, Task 3).
- **Identity archive** (tauriIdentityArchive.ts — keychain-adjacent):
  `archive_identity`, `unarchive_identity`, `list_archived_identities`,
  `resolve_oa_owner`.
- **Observer / local-SQLite archive** (tauriArchive.ts, tauriObserver.ts):
  `archive_events`, `read_archived_events`, `create_save_subscription`,
  `delete_save_subscription`, `list_save_subscriptions`,
  `merge_save_subscription_kinds`, `remove_save_subscription_kind`,
  `observer_archive_default_enabled`, `agent_metric_archive_default_enabled`,
  `index_observer_channel_id`, `read_archived_observer_events_for_channel`,
  `read_unindexed_observer_rows`, `build_observer_control_event`,
  `decrypt_observer_event`.

---

## Counts

- Core (Task 4a): **34** — config 4, channels 15, dms 2, messages 9,
  feed/search 2, canvas 2.
- Task 4b backlog: profiles/presence 6, relay members/agents 6, social 8,
  contacts 2, forum 2, workflows 11, personas 8, teams 9, templates 5,
  workspace 1, nip44 2, media 8, misc 2 = **70** (`not-ported-yet`).
- Removed/excluded: **~80** (not ported).
