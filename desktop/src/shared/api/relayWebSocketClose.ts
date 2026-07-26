import { invoke } from "@tauri-apps/api/core";

import { getTransport } from "@/platform";

/**
 * Close a relay WebSocket through the platform transport seam (Adapter A).
 *
 * Tauri uses Buzz's owned, bounded native disconnect command. Web uses
 * `WebSocket.close(1000, reason)`. Both swallow already-gone socket errors.
 */
export function closeWebSocket(id: number, reason: string): void {
  getTransport().close({ id }, reason);
}

export function closeAllWebSockets(
  invokeFn: typeof invoke = invoke,
): Promise<void> {
  if (import.meta.env?.VITE_PLATFORM === "web") return Promise.resolve();
  return invokeFn("plugin:websocket|disconnect_all").then(
    () => undefined,
    (err) => {
      console.debug("closeAllWebSockets() rejected:", err);
    },
  );
}
