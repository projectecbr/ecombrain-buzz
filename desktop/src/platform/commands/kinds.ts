// Kind constants for the browser command adapter domains.
//
// Keep in sync with shared/constants/kinds.ts. They are inlined here (rather
// than imported) because the contract tests drive these modules under the
// bare node test runner, which cannot resolve the `@/` path alias; type-only
// imports are fine (stripped), runtime imports are not.

export const KIND_TEXT_NOTE = 1;
export const KIND_DELETION = 5;
export const KIND_REACTION = 7;
export const KIND_STREAM_MESSAGE = 9;
export const KIND_STREAM_MESSAGE_V2 = 40002;
export const KIND_STREAM_MESSAGE_EDIT = 40003;
export const KIND_STREAM_MESSAGE_DIFF = 40008;
export const KIND_SYSTEM_MESSAGE = 40099;
export const KIND_JOB_REQUEST = 43001;
export const KIND_JOB_ACCEPTED = 43002;
export const KIND_JOB_PROGRESS = 43003;
export const KIND_JOB_RESULT = 43004;
export const KIND_JOB_CANCEL = 43005;
export const KIND_JOB_ERROR = 43006;
export const KIND_FORUM_POST = 45001;
export const KIND_FORUM_COMMENT = 45003;
export const KIND_HUDDLE_STARTED = 48100;
export const KIND_DM_VISIBILITY = 30622;

/** NIP-98 HTTP auth. */
export const KIND_HTTP_AUTH = 27235;
/** NIP-29 channel metadata / membership. */
export const KIND_CHANNEL_METADATA = 39000;
export const KIND_CHANNEL_MEMBERS = 39002;
/** Channel admin/membership command kinds (see src-tauri/src/events.rs). */
export const KIND_ADD_MEMBER = 9000;
export const KIND_REMOVE_MEMBER = 9001;
export const KIND_UPDATE_CHANNEL = 9002;
export const KIND_CREATE_CHANNEL = 9007;
export const KIND_DELETE_CHANNEL = 9008;
export const KIND_JOIN_CHANNEL = 9021;
export const KIND_LEAVE_CHANNEL = 9022;
/** NIP-DV DM open/hide command kinds. */
export const KIND_DM_OPEN = 41010;
export const KIND_DM_HIDE = 41012;
/** Channel canvas. */
export const KIND_CANVAS = 40100;
/** Workflow approval-request kinds (get_feed needs_action section). */
export const KIND_APPROVAL_KINDS = [46010, 46011, 46012];

/**
 * Timeline content kinds — mirror of `TIMELINE_KINDS` in
 * commands/messages.rs + commands/channel_window.rs (11 kinds). None are in
 * the relay's P_GATED_KINDS, which is load-bearing: the bridge p-gate
 * rejects kindless/p-gated filters before the thread/keyset routing runs.
 */
export const TIMELINE_KINDS = [
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_V2,
  KIND_STREAM_MESSAGE_DIFF,
  KIND_SYSTEM_MESSAGE,
  KIND_JOB_REQUEST,
  KIND_JOB_ACCEPTED,
  KIND_JOB_PROGRESS,
  KIND_JOB_RESULT,
  KIND_JOB_CANCEL,
  KIND_JOB_ERROR,
  KIND_HUDDLE_STARTED,
];

// Validation caps — mirror src-tauri/src/events.rs.
export const MAX_CONTENT_BYTES = 64 * 1024;
export const MAX_MENTIONS = 50;
export const MAX_EMOJI_CHARS = 64;
/** get_channels directory page size — mirror of DIRECTORY_PAGE_SIZE. */
export const DIRECTORY_PAGE_SIZE = 500;
