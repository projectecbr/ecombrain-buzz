// Adapter A (tauri) — PlatformTransport over tauri-plugin-websocket.
//
// Extracted unchanged from `shared/api/relayClientSession.ts` /
// `readOnlyRelayClient.ts` / `relayWebSocketClose.ts`: connect via
// `plugin:websocket|connect` with a Channel, send text frames via
// `plugin:websocket|send`, close via a 1000 Close frame (the plugin registers
// no disconnect command — see relayWebSocketClose.ts). Plugin messages are
// normalized to the PlatformTransport contract: Text payloads arrive as plain
// strings, Close/Error pass through as control frames. Zero behavior change.

import { Channel, invoke } from "@tauri-apps/api/core";

import type {
  PlatformTransport,
  TransportHandle,
  TransportMessage,
} from "./types";

export type TauriTransportOptions = {
  /** Test seam: inject a fake invoke. Defaults to the real Tauri invoke. */
  invokeFn?: typeof invoke;
};

function normalizePluginMessage(message: unknown): TransportMessage | null {
  if (typeof message === "string") {
    return message;
  }

  if (typeof message !== "object" || message === null || !("type" in message)) {
    return null;
  }

  if (
    message.type === "Text" &&
    "data" in message &&
    typeof message.data === "string"
  ) {
    return message.data;
  }

  if (message.type === "Close") {
    return { type: "Close", data: "data" in message ? message.data : null };
  }

  if (message.type === "Error") {
    return { type: "Error", data: "data" in message ? message.data : null };
  }

  // Binary/Ping/Pong frames were ignored by the session layer before; keep
  // dropping them here.
  return null;
}

export function createTauriTransport(
  options: TauriTransportOptions = {},
): PlatformTransport {
  const invokeFn = options.invokeFn ?? invoke;
  // Keep channels alive for the lifetime of their connection (the session
  // layer previously held them in a field for the same reason).
  const channels = new Map<number, Channel<unknown>>();

  return {
    async connect(url, onMessage) {
      // The plugin cannot deliver frames before connect resolves and assigns
      // the id, so the closure may capture the handle by reference.
      let handle: TransportHandle = { id: -1 };
      const channel = new Channel<unknown>((message) => {
        const normalized = normalizePluginMessage(message);
        if (normalized !== null) {
          onMessage(handle, normalized);
        }
      });

      const id = await invokeFn<number>("plugin:websocket|connect", {
        url,
        onMessage: channel,
        config: {},
      });
      handle = { id };
      channels.set(id, channel);
      return handle;
    },

    send(handle, frame) {
      return invokeFn("plugin:websocket|send", {
        id: handle.id,
        message: {
          type: "Text",
          data: frame,
        },
      }).then(() => undefined);
    },

    close(handle, reason = "client closed") {
      channels.delete(handle.id);
      void invokeFn("plugin:websocket|send", {
        id: handle.id,
        message: {
          type: "Close",
          data: { code: 1000, reason },
        },
      }).then(
        () => undefined,
        (err) => {
          // Expected when the socket is already gone; greppable otherwise.
          console.debug(
            `transport.tauri close(${handle.id}, ${reason}) rejected:`,
            err,
          );
        },
      );
    },
  };
}
