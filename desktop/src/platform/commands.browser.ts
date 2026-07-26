// Browser PlatformCommands adapter over NIP-98-signed relay REST.

import type { PlatformCommands } from "./types";
import { agentHandlers } from "./commands/agents.ts";
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
import { forumHandlers } from "./commands/forum.ts";
import { profileHandlers } from "./commands/profiles.ts";
import { socialHandlers } from "./commands/social.ts";
import { workflowHandlers } from "./commands/workflows.ts";

export type { BrowserCommandsOptions } from "./commands/context.ts";
export { relayWsToHttpBase } from "./commands/context.ts";

export function createBrowserCommands(
  options: BrowserCommandsOptions = {},
): PlatformCommands {
  const ctx = createRelayContext(options);
  const handlers = {
    ...agentHandlers(ctx),
    ...channelHandlers(ctx),
    ...forumHandlers(ctx),
    ...messageHandlers(ctx),
    ...profileHandlers(ctx),
    ...socialHandlers(ctx),
    ...workflowHandlers(ctx),
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
      if (command === "is_shared_identity") return true as T;
      if (command === "apply_workspace") return undefined as T;
      if (command === "set_prevent_sleep_active") return undefined as T;
      if (command === "is_auto_update_supported") return false as T;
      if (command === "nip44_encrypt_to_self") {
        const plaintext = (args as { plaintext?: unknown } | undefined)
          ?.plaintext;
        if (typeof plaintext !== "string") {
          throw new Error("plaintext must be a string");
        }
        return (await ctx.signer.encryptToSelf(plaintext)) as T;
      }
      if (command === "nip44_decrypt_from_self") {
        const ciphertext = (args as { ciphertext?: unknown } | undefined)
          ?.ciphertext;
        if (typeof ciphertext !== "string") {
          throw new Error("ciphertext must be a string");
        }
        return (await ctx.signer.decryptFromSelf(ciphertext)) as T;
      }

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
