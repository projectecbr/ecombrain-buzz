// Adapter A (web) — PlatformTransport over the browser WebSocket.
//
// Maps standard WebSocket events onto the exact message shapes the
// `plugin:websocket` Tauri path produced, so `relayClientSession` /
// `readOnlyRelayClient` logic stays untouched:
//   - inbound text frames        → delivered as plain strings
//   - socket closed              → { type: "Close", data: { code, reason } }
//   - socket error (post-open)   → { type: "Error", data: null }
//
// Reconnect/backoff is NOT handled here — relayClientSession owns it (driven
// by the Close/Error frames); this adapter is just the wire.
//
// Node-compatible: the WebSocket constructor is injectable (the contract test
// in ecombrain/contract-tests passes the `ws` package), defaulting to
// globalThis.WebSocket in the browser bundle.

import type {
  PlatformTransport,
  TransportHandle,
  TransportMessage,
} from "./types";

/** Minimal structural subset of the DOM WebSocket used by this adapter. */
export type WebSocketLike = {
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: never) => void,
  ): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export type BrowserTransportOptions = {
  /** WebSocket implementation; defaults to globalThis.WebSocket. */
  WebSocketImpl?: WebSocketConstructor;
};

type MessageEventLike = { data: unknown };
type CloseEventLike = { code: number; reason: string };

export function createBrowserTransport(
  options: BrowserTransportOptions = {},
): PlatformTransport {
  // Numeric ids mirror the plugin:websocket connection ids.
  let nextId = 1;
  const sockets = new Map<number, WebSocketLike>();

  const resolveConstructor = (): WebSocketConstructor => {
    const impl = options.WebSocketImpl ?? globalThis.WebSocket;
    if (!impl) {
      throw new Error(
        "No WebSocket implementation available in this environment.",
      );
    }
    return impl as WebSocketConstructor;
  };

  return {
    connect(url, onMessage) {
      const WebSocketImpl = resolveConstructor();

      return new Promise<TransportHandle>((resolve, reject) => {
        const id = nextId++;
        const handle: TransportHandle = { id };
        const socket = new WebSocketImpl(url);
        let settled = false;

        socket.addEventListener("open", () => {
          settled = true;
          sockets.set(id, socket);
          resolve(handle);
        });

        socket.addEventListener("error", () => {
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket connection to ${url} failed.`));
            return;
          }
          onMessage(handle, { type: "Error", data: null });
        });

        socket.addEventListener("message", (event: MessageEventLike) => {
          // Text frames arrive as strings; the relay protocol is text-only
          // (binary frames are ignored, as relayClientSession did).
          if (typeof event.data === "string") {
            onMessage(handle, event.data);
          }
        });

        socket.addEventListener("close", (event: CloseEventLike) => {
          sockets.delete(id);
          if (!settled) {
            settled = true;
            reject(new Error(`WebSocket connection to ${url} was closed.`));
            return;
          }
          onMessage(handle, {
            type: "Close",
            data: { code: event.code, reason: event.reason },
          });
        });
      });
    },

    send(handle, frame) {
      const socket = sockets.get(handle.id);
      if (!socket) {
        throw new Error(`WebSocket ${handle.id} is not connected.`);
      }
      // Throws synchronously on a dead socket (DOMException); callers
      // `await` this through sendRaw, which turns it into a rejection on the
      // same reconnect path the Tauri plugin's invoke rejection used.
      socket.send(frame);
    },

    close(handle, reason = "client closed") {
      const socket = sockets.get(handle.id);
      if (!socket) return;
      sockets.delete(handle.id);
      try {
        socket.close(1000, reason);
      } catch {
        // Already closing/closed — matches the Tauri close path, which
        // swallowed rejections for already-gone sockets.
      }
    },
  };
}
