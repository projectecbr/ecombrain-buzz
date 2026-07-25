export type MessageLinkInput = {
  channelId: string;
  messageId: string;
  threadRootId?: string | null;
};

export type ParsedMessageLink = {
  channelId: string;
  messageId: string;
  threadRootId: string | null;
};

export type MessageLinkParseResult =
  | { ok: true; value: ParsedMessageLink }
  | { ok: false; reason: string };

export type MessageLinkRenderTarget =
  | { kind: "pill"; link: ParsedMessageLink }
  | { kind: "label"; link: ParsedMessageLink }
  | { kind: "none" };

export function buildMessageLink(input: MessageLinkInput): string {
  if (!input.channelId)
    throw new Error("buildMessageLink: channelId is required");
  if (!input.messageId)
    throw new Error("buildMessageLink: messageId is required");

  const params = new URLSearchParams({ messageId: input.messageId });
  if (input.threadRootId) params.set("threadRootId", input.threadRootId);
  return `${window.location.origin}/teams/#/channels/${encodeURIComponent(input.channelId)}?${params}`;
}

export function parseMessageLink(url: string): MessageLinkParseResult {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.origin);
  } catch {
    return { ok: false, reason: "invalid-url" };
  }

  if (parsed.origin !== window.location.origin) {
    return { ok: false, reason: "wrong-origin" };
  }
  const match = parsed.hash.match(/^#\/channels\/([^?]+)/);
  const channelId = match?.[1] ? decodeURIComponent(match[1]) : "";
  const messageId = new URLSearchParams(parsed.hash.split("?")[1]).get(
    "messageId",
  );
  if (!channelId) return { ok: false, reason: "missing-channel" };
  if (!messageId) return { ok: false, reason: "missing-id" };

  return {
    ok: true,
    value: {
      channelId,
      messageId,
      threadRootId:
        new URLSearchParams(parsed.hash.split("?")[1]).get("threadRootId") ??
        null,
    },
  };
}

export function isMessageLink(href: string | null | undefined): boolean {
  if (!href) return false;
  return parseMessageLink(href).ok;
}

export function resolveMessageLinkRenderTarget({
  href,
  label,
}: {
  href: string;
  label: string;
}): MessageLinkRenderTarget {
  const parsed = parseMessageLink(href);
  if (!parsed.ok) return { kind: "none" };
  return { kind: label === href ? "pill" : "label", link: parsed.value };
}
