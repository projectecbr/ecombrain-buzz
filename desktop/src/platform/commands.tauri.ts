// Adapter C (tauri) — PlatformCommands passthrough to the real Tauri invoke.
//
// Zero behavior change: this is exactly the old `invokeTauri` body
// (shared/api/tauri.ts) lifted behind the platform seam — same `invoke`,
// same `toTauriError` conversion. `invokeFn` is injectable for unit tests.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

import type { PlatformCommands } from "./types";

/** Error normalization — moved verbatim from shared/api/tauri.ts. */
function toTauriError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string") {
    return new Error(error);
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return new Error(error.message);
  }

  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error("Unknown Tauri error");
  }
}

export function createTauriCommands(
  invokeFn: (command: string, args?: unknown) => Promise<unknown> = <T>(
    command: string,
    args?: unknown,
  ): Promise<T> =>
    tauriInvoke<T>(command, args as Record<string, unknown> | undefined),
): PlatformCommands {
  return {
    async call<T>(command: string, args?: unknown): Promise<T> {
      try {
        return (await invokeFn(command, args)) as T;
      } catch (error) {
        throw toTauriError(error);
      }
    },
  };
}
