export const RELAY_BINDING_KEY = "ecombrain-teams-relay-binding-v1";

type RelayBinding = {
  transportUrl: string;
  authUrl: string;
  expiresAt: number;
};

type RelayBindingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function sessionStore(): RelayBindingStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function wsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return (url.protocol === "wss:" || url.protocol === "ws:") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url
      : null;
  } catch {
    return null;
  }
}

function readBinding(storage: RelayBindingStorage | null): RelayBinding | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(
      storage.getItem(RELAY_BINDING_KEY) ?? "null",
    ) as Partial<RelayBinding> | null;
    if (
      !value ||
      !wsUrl(value.transportUrl) ||
      !wsUrl(value.authUrl) ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= Date.now()
    ) {
      storage.removeItem(RELAY_BINDING_KEY);
      return null;
    }
    return value as RelayBinding;
  } catch {
    storage.removeItem(RELAY_BINDING_KEY);
    return null;
  }
}

export function saveRelayBinding(
  binding: RelayBinding,
  storage: RelayBindingStorage | null = sessionStore(),
): void {
  if (
    !wsUrl(binding.transportUrl) ||
    !wsUrl(binding.authUrl) ||
    binding.expiresAt <= Date.now()
  ) {
    throw new Error("Teams relay binding is invalid");
  }
  storage?.setItem(RELAY_BINDING_KEY, JSON.stringify(binding));
}

export function clearRelayBinding(
  storage: RelayBindingStorage | null = sessionStore(),
): void {
  storage?.removeItem(RELAY_BINDING_KEY);
}

export function relayAuthWsUrl(
  transportUrl: string,
  storage: RelayBindingStorage | null = sessionStore(),
): string {
  const binding = readBinding(storage);
  const requested = wsUrl(transportUrl);
  const transport = wsUrl(binding?.transportUrl);
  return binding &&
    requested &&
    transport &&
    requested.toString() === transport.toString()
    ? binding.authUrl
    : transportUrl;
}

function httpUrl(ws: URL): URL {
  const url = new URL(ws);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url;
}

export function relayAuthHttpUrl(
  requestUrl: string,
  storage: RelayBindingStorage | null = sessionStore(),
): string {
  const binding = readBinding(storage);
  if (!binding) return requestUrl;
  try {
    const request = new URL(requestUrl);
    const transport = httpUrl(wsUrl(binding.transportUrl) as URL);
    const auth = httpUrl(wsUrl(binding.authUrl) as URL);
    const transportPath = transport.pathname.replace(/\/+$/, "");
    if (
      request.origin !== transport.origin ||
      (request.pathname !== transportPath &&
        !request.pathname.startsWith(`${transportPath}/`))
    ) {
      return requestUrl;
    }
    const suffix = request.pathname.slice(transportPath.length) || "/";
    auth.pathname = `${auth.pathname.replace(/\/+$/, "")}${suffix}`;
    auth.search = request.search;
    return auth.toString();
  } catch {
    return requestUrl;
  }
}
