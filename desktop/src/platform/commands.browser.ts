// Browser PlatformCommands adapter over NIP-98-signed relay REST.

import type { PlatformCommands } from "./types";
import { channelHandlers } from "./commands/channels.ts";
import {
  activeWorkspaceRelayWsUrl,
  type BrowserCommandsOptions,
  createRelayContext,
  defaultRelayWsUrl,
  relayHttpToWsUrl,
  relayWsToHttpBase,
} from "./commands/context.ts";
import { messageHandlers } from "./commands/messages.ts";
import { socialHandlers } from "./commands/social.ts";

export type { BrowserCommandsOptions } from "./commands/context.ts";
export { relayWsToHttpBase } from "./commands/context.ts";

export function createBrowserCommands(
  options: BrowserCommandsOptions = {},
): PlatformCommands {
  const ctx = createRelayContext(options);
  const handlers = {
    ...channelHandlers(ctx),
    ...messageHandlers(ctx),
    ...socialHandlers(ctx),
  };

  const relayWsUrl = () =>
    activeWorkspaceRelayWsUrl() ??
    (options.baseUrl ? relayHttpToWsUrl(options.baseUrl) : defaultRelayWsUrl());

  return {
    async call<T>(command: string, args?: unknown): Promise<T> {
      if (command === "get_relay_ws_url") return relayWsUrl() as T;
      if (command === "get_relay_http_url") {
        return relayWsToHttpBase(relayWsUrl()) as T;
      }
      if (command === "get_default_relay_url") {
        return (
          options.baseUrl
            ? relayHttpToWsUrl(options.baseUrl)
            : defaultRelayWsUrl()
        ) as T;
      }
      if (command === "is_shared_identity") return false as T;

      const handler = handlers[command];
      if (!handler) {
        throw new Error(
          `not-ported-yet: ${command} (see ecombrain/phase2/command-map.md)`,
        );
      }
      return (await handler((args ?? {}) as Record<string, unknown>)) as T;
    },
  };
}
