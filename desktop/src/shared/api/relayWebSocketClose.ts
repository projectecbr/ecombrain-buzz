import { getTransport } from "@/platform";

/**
 * Close a relay WebSocket through the platform transport seam (Adapter A).
 *
 * Tauri: tauri-plugin-websocket 2.4.2 registers only `connect` and `send` —
 * there is no `disconnect` command, so the transport sends a 1000 Close frame
 * and the plugin's read loop drops the connection when the peer echoes the
 * Close. Web: `WebSocket.close(1000, reason)`. Both swallow errors from
 * already-gone sockets.
 */
export function closeWebSocket(id: number, reason: string): void {
  getTransport().close({ id }, reason);
}
