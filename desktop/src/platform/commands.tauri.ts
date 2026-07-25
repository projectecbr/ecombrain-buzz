// Adapter C (tauri) — PlatformCommands passthrough to the real Tauri invoke.
//
// The shared invokeTauri wrapper owns error normalization and rate-limit
// handling. This adapter only selects the native command transport.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import type { PlatformCommands } from "./types";

export function createTauriCommands(
  invokeFn: (command: string, args?: unknown) => Promise<unknown> = <T>(
    command: string,
    args?: unknown,
  ): Promise<T> =>
    tauriInvoke<T>(command, args as Record<string, unknown> | undefined),
): PlatformCommands {
  return {
    call: <T>(command: string, args?: unknown): Promise<T> =>
      invokeFn(command, args) as Promise<T>,
  };
}
