const encoder = new TextEncoder();
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const COMMUNITY_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type RelayNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

export type IngressEnv = {
  RELAY: RelayNamespace;
  TEAMS_INGRESS_SERVICE_SECRET: string;
  TEAMS_PRODUCT_API_URL: string;
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

export async function serviceHeaders(input: {
  secret: string;
  url: string;
  body: string;
  now?: number;
  requestId?: string;
}): Promise<Record<string, string>> {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1_000);
  const expiresAt = issuedAt + 30;
  const audience = "teams-ingress:relay";
  const requestId = input.requestId ?? crypto.randomUUID();
  const bodyHash = await digest(input.body);
  const canonical = [
    "POST",
    new URL(input.url).pathname,
    audience,
    issuedAt,
    expiresAt,
    requestId,
    bodyHash,
  ].join("\n");
  return {
    Authorization: `Teams-HMAC ${await hmac(input.secret, canonical)}`,
    "Content-Type": "application/json",
    "X-Teams-Service-Audience": audience,
    "X-Teams-Service-Issued-At": String(issuedAt),
    "X-Teams-Service-Expires-At": String(expiresAt),
    "X-Teams-Service-Request-Id": requestId,
    "X-Teams-Service-Body-Sha256": bodyHash,
  };
}

function sessionToken(request: Request): string | null {
  const value = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("ecombrain_teams_session="))
    ?.slice("ecombrain_teams_session=".length);
  return value && SESSION_TOKEN.test(value) ? value : null;
}

function relayPath(pathname: string): string | null {
  if (pathname === "/teams/relay") return "/";
  if (pathname.startsWith("/teams/relay/")) {
    return pathname.slice("/teams/relay".length);
  }
  return null;
}

function error(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export function createIngressHandler(fetcher: typeof fetch = fetch) {
  return async function handle(
    request: Request,
    env: IngressEnv,
  ): Promise<Response> {
    const incomingUrl = new URL(request.url);
    const path = relayPath(incomingUrl.pathname);
    if (!path) return error(404, "Not found");

    const token = sessionToken(request);
    if (!token) return error(401, "Unauthorized");
    const secret = env.TEAMS_INGRESS_SERVICE_SECRET?.trim();
    const productBase = env.TEAMS_PRODUCT_API_URL?.trim();
    if (!secret || secret.length < 32 || !productBase) {
      return error(503, "Teams ingress unavailable");
    }
    const productUrl = new URL(
      "/api/internal/teams/ingress/session",
      productBase,
    );
    if (productUrl.protocol !== "https:") {
      return error(503, "Teams ingress unavailable");
    }
    const body = JSON.stringify({ token });

    let sessionResponse: Response;
    try {
      sessionResponse = await fetcher(productUrl, {
        method: "POST",
        headers: await serviceHeaders({
          secret,
          url: productUrl.toString(),
          body,
        }),
        body,
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      return error(503, "Teams session unavailable");
    }
    if (!sessionResponse.ok) {
      return error(
        sessionResponse.status === 401 ? 401 : 503,
        sessionResponse.status === 401
          ? "Unauthorized"
          : "Teams session unavailable",
      );
    }
    const session = (await sessionResponse.json().catch(() => null)) as {
      communityHost?: unknown;
    } | null;
    if (
      !session ||
      typeof session.communityHost !== "string" ||
      !COMMUNITY_HOST.test(session.communityHost)
    ) {
      return error(503, "Teams session unavailable");
    }

    const headers = new Headers(request.headers);
    headers.set("Host", session.communityHost);
    for (const name of [
      "cookie",
      "forwarded",
      "x-forwarded-host",
      "x-original-host",
      "x-spike-secret",
      "x-spike-tenant-override",
      "x-teams-tenant",
      "x-tenant-id",
    ])
      headers.delete(name);

    const relayUrl = new URL(path + incomingUrl.search, "http://relay");
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: "manual",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }
    const relay = env.RELAY.get(env.RELAY.idFromName("relay-singleton"));
    return relay.fetch(new Request(relayUrl, init));
  };
}
