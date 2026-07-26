const encoder = new TextEncoder();
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_AUDIENCE = /^teams-relay-service:(identity|agent|scheduler):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
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
  TEAMS_RELAY_SERVICE_SECRET: string;
};

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function digestBytes(value: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", value));
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

function bytes(value: string): Uint8Array | null {
  if (!SHA256.test(value)) return null;
  return Uint8Array.from(value.match(/../g) ?? [], (pair) =>
    Number.parseInt(pair, 16),
  );
}

async function verifyHmac(
  secret: string,
  value: string,
  signature: string,
): Promise<boolean> {
  const signatureBytes = bytes(signature);
  if (!signatureBytes) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signatureBuffer = signatureBytes.buffer.slice(
    signatureBytes.byteOffset,
    signatureBytes.byteOffset + signatureBytes.byteLength,
  ) as ArrayBuffer;
  return crypto.subtle.verify(
    "HMAC",
    key,
    signatureBuffer,
    encoder.encode(value),
  );
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

export async function relayServiceHeaders(input: {
  serviceSecret: string;
  service: "identity" | "agent" | "scheduler";
  communityId: string;
  method: string;
  url: string;
  body?: string;
  now?: number;
  requestId?: string;
}): Promise<Record<string, string>> {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1_000);
  const expiresAt = issuedAt + 30;
  const audience = `teams-relay-service:${input.service}:${input.communityId}`;
  if (!SERVICE_AUDIENCE.test(audience) || input.serviceSecret.length < 32) {
    throw new Error("invalid relay service scope");
  }
  const requestId = input.requestId ?? crypto.randomUUID();
  const bodyHash = await digest(input.body ?? "");
  const url = new URL(input.url);
  const canonical = [
    input.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    audience,
    issuedAt,
    expiresAt,
    requestId,
    bodyHash,
  ].join("\n");
  return {
    "X-Teams-Relay-Authorization": `Teams-HMAC ${await hmac(input.serviceSecret, canonical)}`,
    "X-Teams-Relay-Audience": audience,
    "X-Teams-Relay-Issued-At": String(issuedAt),
    "X-Teams-Relay-Expires-At": String(expiresAt),
    "X-Teams-Relay-Request-Id": requestId,
    "X-Teams-Relay-Body-Sha256": bodyHash,
  };
}

type VerifiedRelayService = {
  audience: string;
  communityId: string;
  requestId: string;
  expiresAt: number;
};

async function verifyRelayServiceRequest(
  request: Request,
  masterSecret: string,
): Promise<VerifiedRelayService | null> {
  const authorization = request.headers.get("x-teams-relay-authorization") ?? "";
  const signature = authorization.startsWith("Teams-HMAC ")
    ? authorization.slice("Teams-HMAC ".length)
    : "";
  const audience = request.headers.get("x-teams-relay-audience") ?? "";
  const issuedAt = Number(request.headers.get("x-teams-relay-issued-at"));
  const expiresAt = Number(request.headers.get("x-teams-relay-expires-at"));
  const requestId = request.headers.get("x-teams-relay-request-id") ?? "";
  const bodyHash = request.headers.get("x-teams-relay-body-sha256") ?? "";
  const audienceMatch = SERVICE_AUDIENCE.exec(audience);
  const now = Math.floor(Date.now() / 1_000);
  if (
    masterSecret.length < 32 ||
    !audienceMatch ||
    !REQUEST_ID.test(requestId) ||
    !SHA256.test(bodyHash) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > now + 15 ||
    expiresAt < now - 15 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 60
  ) {
    return null;
  }
  const actualBodyHash = await digestBytes(await request.clone().arrayBuffer());
  if (actualBodyHash !== bodyHash) return null;
  const url = new URL(request.url);
  const canonical = [
    request.method.toUpperCase(),
    `${url.pathname}${url.search}`,
    audience,
    issuedAt,
    expiresAt,
    requestId,
    bodyHash,
  ].join("\n");
  const derivedSecret = await hmac(masterSecret, audience);
  if (!(await verifyHmac(derivedSecret, canonical, signature))) return null;
  return {
    audience,
    communityId: audienceMatch[2].toLowerCase(),
    requestId,
    expiresAt,
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

function relayServicePath(pathname: string): string | null {
  if (pathname === "/teams/service/relay") return "/";
  if (pathname.startsWith("/teams/service/relay/")) {
    return pathname.slice("/teams/service/relay".length);
  }
  return null;
}

function error(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

function relayRequest(
  request: Request,
  path: string,
  communityHost: string,
): Request {
  const incomingUrl = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("Host", communityHost);
  for (const name of [
    "cookie",
    "forwarded",
    "x-forwarded-host",
    "x-original-host",
    "x-spike-secret",
    "x-spike-tenant-override",
    "x-teams-tenant",
    "x-tenant-id",
    "x-teams-relay-authorization",
    "x-teams-relay-audience",
    "x-teams-relay-issued-at",
    "x-teams-relay-expires-at",
    "x-teams-relay-request-id",
    "x-teams-relay-body-sha256",
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
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  return new Request(relayUrl, init);
}

export function createIngressHandler(fetcher: typeof fetch = fetch) {
  return async function handle(
    request: Request,
    env: IngressEnv,
  ): Promise<Response> {
    const incomingUrl = new URL(request.url);
    const browserPath = relayPath(incomingUrl.pathname);
    const servicePath = relayServicePath(incomingUrl.pathname);
    if (!browserPath && !servicePath) return error(404, "Not found");

    const secret = env.TEAMS_INGRESS_SERVICE_SECRET?.trim();
    const productBase = env.TEAMS_PRODUCT_API_URL?.trim();
    if (!secret || secret.length < 32 || !productBase) {
      return error(503, "Teams ingress unavailable");
    }
    let productOrigin: URL;
    try {
      productOrigin = new URL(productBase);
    } catch {
      return error(503, "Teams ingress unavailable");
    }
    if (productOrigin.protocol !== "https:") {
      return error(503, "Teams ingress unavailable");
    }
    let path: string;
    let communityHost: string;

    if (servicePath) {
      const verified = await verifyRelayServiceRequest(
        request,
        env.TEAMS_RELAY_SERVICE_SECRET?.trim() ?? "",
      );
      if (!verified) return error(401, "Unauthorized");
      const productUrl = new URL(
        "/api/internal/teams/ingress/service",
        productOrigin,
      );
      const body = JSON.stringify({
        audience: verified.audience,
        requestId: verified.requestId,
        expiresAt: verified.expiresAt,
      });
      let response: Response;
      try {
        response = await fetcher(productUrl, {
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
        return error(503, "Teams service unavailable");
      }
      if (!response.ok) {
        return error(
          response.status === 401 ? 401 : 503,
          response.status === 401
            ? "Unauthorized"
            : "Teams service unavailable",
        );
      }
      const binding = (await response.json().catch(() => null)) as {
        communityHost?: unknown;
      } | null;
      if (
        !binding ||
        typeof binding.communityHost !== "string" ||
        !COMMUNITY_HOST.test(binding.communityHost)
      ) {
        return error(503, "Teams service unavailable");
      }
      path = servicePath;
      communityHost = binding.communityHost;
    } else {
      const token = sessionToken(request);
      if (!token) return error(401, "Unauthorized");
      const productUrl = new URL(
        "/api/internal/teams/ingress/session",
        productOrigin,
      );
      const body = JSON.stringify({ token });
      let response: Response;
      try {
        response = await fetcher(productUrl, {
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
      if (!response.ok) {
        return error(
          response.status === 401 ? 401 : 503,
          response.status === 401
            ? "Unauthorized"
            : "Teams session unavailable",
        );
      }
      const session = (await response.json().catch(() => null)) as {
        communityHost?: unknown;
      } | null;
      if (
        !session ||
        typeof session.communityHost !== "string" ||
        !COMMUNITY_HOST.test(session.communityHost)
      ) {
        return error(503, "Teams session unavailable");
      }
      path = browserPath as string;
      communityHost = session.communityHost;
    }

    const relay = env.RELAY.get(env.RELAY.idFromName("relay-singleton"));
    return relay.fetch(relayRequest(request, path, communityHost));
  };
}
