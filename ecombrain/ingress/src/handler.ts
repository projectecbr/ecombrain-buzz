const encoder = new TextEncoder();
const SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_AUDIENCE = /^teams-relay-service:(identity|agent|scheduler):([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const OPERATOR_AUDIENCE = /^teams-relay-operator:[0-9a-f]{64}$/i;
const COMMUNITY_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

type ContainerNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
};

export type IngressEnv = {
  RELAY: ContainerNamespace;
  IDENTITY_BRIDGE: ContainerNamespace;
  TEAMS_INGRESS_SERVICE_SECRET: string;
  TEAMS_PRODUCT_API_URL: string;
  TEAMS_RELAY_SERVICE_SECRET: string;
  TEAMS_OPERATOR_SERVICE_SECRET: string;
  TEAMS_BUNKER_PUBKEY: string;
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
  subject?: "relay" | "operator";
  now?: number;
  requestId?: string;
}): Promise<Record<string, string>> {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1_000);
  const expiresAt = issuedAt + 30;
  const audience = `teams-ingress:${input.subject ?? "relay"}`;
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

export async function operatorServiceHeaders(input: {
  secret: string;
  bunkerPubkey: string;
  method: string;
  url: string;
  body?: string;
  now?: number;
  requestId?: string;
}): Promise<Record<string, string>> {
  const issuedAt = Math.floor((input.now ?? Date.now()) / 1_000);
  const expiresAt = issuedAt + 30;
  const audience = `teams-relay-operator:${input.bunkerPubkey.toLowerCase()}`;
  if (!OPERATOR_AUDIENCE.test(audience) || input.secret.length < 32) {
    throw new Error("invalid relay operator scope");
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
    "X-Teams-Operator-Authorization": `Teams-HMAC ${await hmac(input.secret, canonical)}`,
    "X-Teams-Operator-Audience": audience,
    "X-Teams-Operator-Issued-At": String(issuedAt),
    "X-Teams-Operator-Expires-At": String(expiresAt),
    "X-Teams-Operator-Request-Id": requestId,
    "X-Teams-Operator-Body-Sha256": bodyHash,
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

async function verifyOperatorServiceRequest(
  request: Request,
  secret: string,
  bunkerPubkey: string,
): Promise<{ audience: string; requestId: string; expiresAt: number } | null> {
  const authorization = request.headers.get("x-teams-operator-authorization") ?? "";
  const signature = authorization.startsWith("Teams-HMAC ")
    ? authorization.slice("Teams-HMAC ".length)
    : "";
  const audience = request.headers.get("x-teams-operator-audience") ?? "";
  const issuedAt = Number(request.headers.get("x-teams-operator-issued-at"));
  const expiresAt = Number(request.headers.get("x-teams-operator-expires-at"));
  const requestId = request.headers.get("x-teams-operator-request-id") ?? "";
  const bodyHash = request.headers.get("x-teams-operator-body-sha256") ?? "";
  const now = Math.floor(Date.now() / 1_000);
  if (
    secret.length < 32 ||
    !OPERATOR_AUDIENCE.test(audience) ||
    audience !== `teams-relay-operator:${bunkerPubkey.toLowerCase()}` ||
    !REQUEST_ID.test(requestId) ||
    !SHA256.test(bodyHash) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    issuedAt > now + 15 ||
    expiresAt < now - 15 ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > 60
  ) return null;
  if (await digestBytes(await request.clone().arrayBuffer()) !== bodyHash) return null;
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
  return await verifyHmac(secret, canonical, signature)
    ? { audience, requestId, expiresAt }
    : null;
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

function operatorServicePath(pathname: string): string | null {
  if (pathname === "/teams/service/operator/communities") {
    return "/operator/communities";
  }
  if (pathname === "/teams/service/operator/communities/availability") {
    return "/operator/communities/availability";
  }
  return null;
}

function isBunkerPath(pathname: string): boolean {
  return pathname === "/teams/bunker";
}

function isIdentityControlPath(pathname: string): boolean {
  return pathname === "/teams/service/identity/provision";
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
    "x-teams-operator-authorization",
    "x-teams-operator-audience",
    "x-teams-operator-issued-at",
    "x-teams-operator-expires-at",
    "x-teams-operator-request-id",
    "x-teams-operator-body-sha256",
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

function bunkerRequest(request: Request): Request {
  const headers = new Headers(request.headers);
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
  return new Request("http://identity-bridge/", {
    method: "GET",
    headers,
    redirect: "manual",
  });
}

function identityControlRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of [
    "cookie",
    "forwarded",
    "host",
    "x-forwarded-host",
    "x-original-host",
    "x-spike-secret",
    "x-spike-tenant-override",
    "x-teams-tenant",
    "x-tenant-id",
  ]) headers.delete(name);
  const init: RequestInit = {
    method: "POST",
    headers,
    body: request.body,
    redirect: "manual",
  };
  (init as RequestInit & { duplex: "half" }).duplex = "half";
  return new Request("http://identity-bridge/provision", init);
}

async function validateBrowserSession(
  request: Request,
  secret: string,
  productOrigin: URL,
  fetcher: typeof fetch,
): Promise<{ communityHost: string } | Response> {
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
      response.status === 401 ? "Unauthorized" : "Teams session unavailable",
    );
  }
  const session = (await response.json().catch(() => null)) as {
    communityHost?: unknown;
  } | null;
  return session &&
    typeof session.communityHost === "string" &&
    COMMUNITY_HOST.test(session.communityHost)
    ? { communityHost: session.communityHost }
    : error(503, "Teams session unavailable");
}

export function createIngressHandler(fetcher: typeof fetch = fetch) {
  return async function handle(
    request: Request,
    env: IngressEnv,
  ): Promise<Response> {
    const incomingUrl = new URL(request.url);
    const browserPath = relayPath(incomingUrl.pathname);
    const servicePath = relayServicePath(incomingUrl.pathname);
    const operatorPath = operatorServicePath(incomingUrl.pathname);
    const bunker = isBunkerPath(incomingUrl.pathname);
    const identityControl = isIdentityControlPath(incomingUrl.pathname);
    if (!browserPath && !servicePath && !operatorPath && !bunker && !identityControl) return error(404, "Not found");

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
    if (identityControl) {
      if (request.method !== "POST") return error(405, "Method not allowed");
      const bridge = env.IDENTITY_BRIDGE?.get(
        env.IDENTITY_BRIDGE.idFromName("identity-bridge-singleton"),
      );
      return bridge
        ? bridge.fetch(identityControlRequest(request))
        : error(503, "Teams provisioning unavailable");
    }
    if (bunker) {
      if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return error(400, "WebSocket upgrade required");
      }
      const session = await validateBrowserSession(
        request,
        secret,
        productOrigin,
        fetcher,
      );
      if (session instanceof Response) return session;
      const bridge = env.IDENTITY_BRIDGE?.get(
        env.IDENTITY_BRIDGE.idFromName("identity-bridge-singleton"),
      );
      return bridge
        ? bridge.fetch(bunkerRequest(request))
        : error(503, "Teams signer unavailable");
    }
    let path: string;
    let communityHost: string;

    if (operatorPath) {
      const verified = await verifyOperatorServiceRequest(
        request,
        env.TEAMS_OPERATOR_SERVICE_SECRET?.trim() ?? "",
        env.TEAMS_BUNKER_PUBKEY?.trim() ?? "",
      );
      if (!verified) return error(401, "Unauthorized");
      const productUrl = new URL("/api/internal/teams/ingress/service", productOrigin);
      const body = JSON.stringify(verified);
      let response: Response;
      try {
        response = await fetcher(productUrl, {
          method: "POST",
          headers: await serviceHeaders({
            secret,
            url: productUrl.toString(),
            body,
            subject: "operator",
          }),
          body,
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        return error(503, "Teams operator unavailable");
      }
      if (!response.ok) {
        return error(response.status === 401 ? 401 : 503, "Teams operator unavailable");
      }
      path = operatorPath;
      communityHost = "operator.teams.ecombrain.internal";
    } else if (servicePath) {
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
      const session = await validateBrowserSession(
        request,
        secret,
        productOrigin,
        fetcher,
      );
      if (session instanceof Response) return session;
      path = browserPath as string;
      communityHost = session.communityHost;
    }

    const relay = env.RELAY.get(env.RELAY.idFromName("relay-singleton"));
    return relay.fetch(relayRequest(request, path, communityHost));
  };
}
