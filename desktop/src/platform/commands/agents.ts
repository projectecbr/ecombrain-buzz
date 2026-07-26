import { type Args, relayWsToHttpBase, type RelayContext } from "./context.ts";

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function agentHandlers(
  ctx: RelayContext,
): Record<string, (args: Args) => unknown | Promise<unknown>> {
  async function listRelayAgents() {
    const events = await ctx.relayQuery([{ kinds: [10100] }]);
    return events.map((event) => {
      let content: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(event.content) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          content = parsed as Record<string, unknown>;
        }
      } catch {
        // A malformed profile still resolves to a safe offline agent record.
      }
      const displayName =
        typeof content.display_name === "string" && content.display_name.trim()
          ? content.display_name
          : event.pubkey;
      return {
        ...content,
        pubkey: event.pubkey,
        name: typeof content.name === "string" ? content.name : displayName,
        agent_type:
          typeof content.agent_type === "string" ? content.agent_type : "agent",
        channels: stringArray(content.channels),
        channel_ids: stringArray(content.channel_ids),
        capabilities: stringArray(content.capabilities),
        status:
          content.status === "online" ||
          content.status === "away" ||
          content.status === "offline"
            ? content.status
            : "offline",
        respond_to: content.respond_to,
        respond_to_allowlist: stringArray(content.respond_to_allowlist),
      };
    });
  }

  async function getRelaySelf() {
    try {
      const response = await (ctx.options.fetchFn ?? globalThis.fetch)(
        ctx.baseUrl(),
        { headers: { Accept: "application/nostr+json" } },
      );
      if (!response.ok) return null;
      const document = (await response.json()) as { self?: unknown };
      return typeof document.self === "string" &&
        /^[0-9a-f]{64}$/.test(document.self)
        ? document.self
        : null;
    } catch {
      return null;
    }
  }

  async function fetchWorkspaceIcon(args: Args) {
    const relayUrl = args.relayUrl;
    if (typeof relayUrl !== "string" || !relayUrl.trim()) return null;
    try {
      const response = await (ctx.options.fetchFn ?? globalThis.fetch)(
        relayWsToHttpBase(relayUrl),
        { headers: { Accept: "application/nostr+json" } },
      );
      if (!response.ok) return null;
      const document = (await response.json()) as { icon?: unknown };
      return typeof document.icon === "string" && document.icon
        ? document.icon
        : null;
    } catch {
      return null;
    }
  }

  return {
    get_relay_self: getRelaySelf,
    fetch_workspace_icon: fetchWorkspaceIcon,
    list_relay_agents: listRelayAgents,
  };
}
