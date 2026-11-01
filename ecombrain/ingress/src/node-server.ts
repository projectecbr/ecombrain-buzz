/**
 * Node transport for the Teams ingress, for hosts without Cloudflare Containers (a VPS behind a tunnel).
 * Every auth and routing decision stays in handler.ts: this file only turns node:http requests into
 * WHATWG Requests, runs the same handler, and carries the handler's rewritten request to a local
 * upstream (relay or identity bridge). WebSocket upgrades are piped only after the handler admitted them.
 *
 * Framing is never copied from the client: the upstream request's length or chunking is derived from the
 * body this process actually sends, and every upstream call gets its own connection, so a crafted request
 * can't smuggle a second request (with another tenant's Host) to the relay.
 */
import { STATUS_CODES, request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Readable, Transform, pipeline } from "node:stream";
import { createIngressHandler, type IngressEnv } from "./handler.ts";

export type NodeIngressOptions = {
  /** Secrets and product URL, exactly as the worker reads them. */
  env: Omit<IngressEnv, "RELAY" | "IDENTITY_BRIDGE">;
  /** Local origins, for example http://127.0.0.1:3001. Plain HTTP on loopback or a private network only. */
  relayUpstream: string;
  identityBridgeUpstream: string;
  /** The public origin the tunnel serves; only the path of an incoming request is used. */
  publicOrigin: string;
  /** Session-checked relay bodies (media uploads). */
  maxBodyBytes?: number;
  /** Signed service bodies, which handler.ts buffers before it checks the signature. */
  maxServiceBodyBytes?: number;
  /** Signed service requests with a body allowed in flight at once; more get 503. */
  maxServiceInFlight?: number;
  upstreamIdleMs?: number;
  upgradeHandshakeMs?: number;
  fetcher?: typeof fetch;
};

type Target = { upstream: URL; request: Request; length: number | null };

const DEFAULT_MAX_BODY = 100 * 1024 * 1024; // the Workers request body limit the worker ran under
// shortcut: 1 MB assumes signed service and operator calls carry small JSON; raise it if a caller needs more.
const DEFAULT_MAX_SERVICE_BODY = 1024 * 1024;
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "content-length"];
const ADMITTED = new Response(null, { status: 204 });
const upgradedSockets = new WeakMap<Server, Set<Duplex>>();

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** A container namespace whose fetch only records where the handler sent the request. */
function capture(upstream: URL, sink: { target: { upstream: URL; request: Request } | null }) {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (request: Request) => {
        sink.target = { upstream, request };
        return ADMITTED;
      },
    }),
  };
}

function headersOf(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (let i = 0; i < message.rawHeaders.length; i += 2) headers.append(message.rawHeaders[i], message.rawHeaders[i + 1]);
  return headers;
}

function limit(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      done(seen > maxBytes ? new Error("body too large") : null, chunk);
    },
  });
}

/** Declared length, or null for a chunked body; undefined when the request has no body at all. */
function bodyLength(message: IncomingMessage): number | null | undefined {
  if (message.headers["transfer-encoding"] !== undefined) return null; // Node's parser already refused CL + TE
  const declared = message.headers["content-length"];
  if (declared === undefined) return undefined;
  const length = Number(declared);
  return length > 0 ? length : undefined;
}

/** Classified on the normalised path, the same one handler.ts routes on (`/teams/relay/../service/...` is a service path). */
function isServicePath(raw: string, publicOrigin: URL): boolean {
  try {
    return new URL(raw, publicOrigin).pathname.startsWith("/teams/service/");
  } catch {
    return false; // toRequest refuses it next
  }
}

/** Builds the WHATWG request, or the error response for a target or body this ingress refuses. */
function toRequest(message: IncomingMessage, publicOrigin: URL, maxBytes: number): { request: Request; length: number | null | undefined } | Response {
  const raw = message.url ?? "";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return jsonError(400, "Bad request");
  const url = new URL(raw, publicOrigin);
  if (url.origin !== publicOrigin.origin) return jsonError(400, "Bad request");
  const length = bodyLength(message);
  if (length !== undefined && length !== null && length > maxBytes) return jsonError(413, "Payload too large");
  const method = message.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers: headersOf(message), redirect: "manual" };
  // GET and HEAD never carry a body upstream; any body they declared is dropped with its length.
  const sendsBody = length !== undefined && method !== "GET" && method !== "HEAD";
  if (sendsBody) {
    const body = pipeline(message, limit(maxBytes), () => {}); // a client abort destroys the limit stream too
    init.body = Readable.toWeb(body) as ReadableStream;
    init.duplex = "half";
  }
  return { request: new Request(url, init), length: sendsBody ? length : undefined };
}

/** End-to-end headers only: hop-by-hop, framing and anything the client listed in Connection are dropped. */
function endToEndHeaders(request: Request): Record<string, string> {
  const listed = (request.headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    // Host is the handler's tenant binding: a client listing it in Connection must not remove it.
    if (HOP_BY_HOP.includes(name) || (listed.includes(name) && name !== "host")) return;
    headers[name] = value;
  });
  return headers;
}

function upstreamOptions(target: Target, headers: Record<string, string>) {
  const url = new URL(target.request.url);
  return {
    protocol: target.upstream.protocol,
    hostname: target.upstream.hostname,
    port: target.upstream.port,
    method: target.request.method,
    path: `${url.pathname}${url.search}`,
    headers, // carries the handler's Host (the session-bound community host)
    agent: false as const, // one connection per request: nothing a client sends can reach another user's request
  };
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function writeSocketHead(socket: Duplex, status: number, rawHeaders: readonly string[], body: Buffer): void {
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Unknown"}`];
  for (let i = 0; i < rawHeaders.length; i += 2) lines.push(`${rawHeaders[i]}: ${rawHeaders[i + 1]}`);
  lines.push(`content-length: ${body.length}`, "connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

async function writeSocketResponse(socket: Duplex, response: Response): Promise<void> {
  const raw: string[] = [];
  response.headers.forEach((value, name) => raw.push(name, value));
  writeSocketHead(socket, response.status, raw, Buffer.from(await response.arrayBuffer()));
}

function forwardHttp(target: Target, res: ServerResponse, idleMs: number): void {
  const headers = endToEndHeaders(target.request);
  const body = target.request.body;
  if (body) {
    if (target.length !== null) headers["content-length"] = String(target.length);
    else headers["transfer-encoding"] = "chunked";
  } else if (target.request.method !== "GET" && target.request.method !== "HEAD") {
    headers["content-length"] = "0";
  }
  const upstream = httpRequest(upstreamOptions(target, headers));
  let tooLarge = false;
  upstream.setTimeout(idleMs, () => upstream.destroy(new Error("upstream timeout")));
  // The client leaving cancels the upstream call, as the worker runtime cancelled subrequests.
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  upstream.on("response", (upstreamRes) => {
    const responseHeaders = { ...upstreamRes.headers };
    for (const name of HOP_BY_HOP) if (name !== "content-length") delete responseHeaders[name];
    res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
    pipeline(upstreamRes, res, (error) => { if (error) { upstream.destroy(); res.destroy(); } });
  });
  upstream.on("error", (error) => {
    if (res.headersSent) return void res.destroy();
    if (tooLarge) return void writeResponse(res, jsonError(413, "Payload too large"));
    const timedOut = error.message === "upstream timeout";
    void writeResponse(res, jsonError(timedOut ? 504 : 502, "Teams upstream unavailable"));
  });
  if (body) {
    pipeline(Readable.fromWeb(body as never), upstream, (error) => {
      if (!error) return;
      tooLarge = error.message === "body too large";
      upstream.destroy();
    });
  }
  else upstream.end();
}

function pipeSockets(client: Duplex, upstream: Duplex, open: Set<Duplex>): void {
  open.add(client);
  let closed = false;
  const destroy = () => { if (closed) return; closed = true; client.destroy(); upstream.destroy(); open.delete(client); };
  // An end on one side ends the other (so a queued close frame still goes out), then a short grace.
  const halfClose = (other: Duplex) => () => { other.end(); setTimeout(destroy, 5_000).unref(); };
  client.on("end", halfClose(upstream));
  upstream.on("end", halfClose(client));
  for (const side of [client, upstream]) { side.on("close", destroy); side.on("error", destroy); }
  upstream.pipe(client);
  client.pipe(upstream);
}

function forwardUpgrade(target: Target, socket: Duplex, head: Buffer, handshakeMs: number, open: Set<Duplex>, early: () => Buffer): void {
  if (socket.destroyed) return; // the client left during the session check
  const headers = { ...endToEndHeaders(target.request), connection: "Upgrade", upgrade: "websocket" };
  const upstream = httpRequest(upstreamOptions(target, headers));
  const abandon = () => upstream.destroy();
  socket.once("close", abandon); // the client left before the upstream answered
  upstream.setTimeout(handshakeMs, () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.off("close", abandon);
    upstreamSocket.setTimeout(0);
    head = Buffer.concat([head, early()]);
    const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage || "Switching Protocols"}`];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    pipeSockets(socket, upstreamSocket, open);
  });
  upstream.on("response", (upstreamRes) => {
    // The upstream refused the upgrade: pass its answer through and close.
    socket.off("close", abandon);
    const chunks: Buffer[] = [];
    upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const raw: string[] = [];
      for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) {
        if (!HOP_BY_HOP.includes(upstreamRes.rawHeaders[i].toLowerCase())) raw.push(upstreamRes.rawHeaders[i], upstreamRes.rawHeaders[i + 1]);
      }
      writeSocketHead(socket, upstreamRes.statusCode ?? 502, raw, Buffer.concat(chunks));
    });
  });
  upstream.on("error", (error) => {
    if (socket.destroyed) return;
    void writeSocketResponse(socket, jsonError(error.message === "upstream timeout" ? 504 : 502, "Teams upstream unavailable"));
  });
  upstream.end();
}

export function createNodeIngress(options: NodeIngressOptions): Server {
  const handle = createIngressHandler(options.fetcher ?? fetch);
  const publicOrigin = new URL(options.publicOrigin);
  const relay = new URL(options.relayUpstream);
  const bridge = new URL(options.identityBridgeUpstream);
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const maxServiceBytes = options.maxServiceBodyBytes ?? DEFAULT_MAX_SERVICE_BODY;
  const maxServiceInFlight = options.maxServiceInFlight ?? 32;
  const idleMs = options.upstreamIdleMs ?? 60_000;
  const handshakeMs = options.upgradeHandshakeMs ?? 10_000;
  const open = new Set<Duplex>();
  let serviceInFlight = 0;

  async function decide(message: IncomingMessage): Promise<Target | Response> {
    const service = isServicePath(message.url ?? "", publicOrigin);
    const built = toRequest(message, publicOrigin, service ? maxServiceBytes : maxBytes);
    if (built instanceof Response) return built;
    // handler.ts buffers a signed body before it checks the signature: bound how much of that runs at once.
    const counted = service && built.length !== undefined;
    if (counted && serviceInFlight >= maxServiceInFlight) return jsonError(503, "Teams service busy");
    if (counted) serviceInFlight += 1;
    const sink: { target: { upstream: URL; request: Request } | null } = { target: null };
    const env = { ...options.env, RELAY: capture(relay, sink), IDENTITY_BRIDGE: capture(bridge, sink) } as IngressEnv;
    try {
      const response = await handle(built.request, env);
      return response === ADMITTED && sink.target ? { ...sink.target, length: built.length ?? null } : response;
    } catch {
      return jsonError(413, "Payload too large"); // the only throw: a body over the cap while the handler hashed it
    } finally {
      if (counted) serviceInFlight -= 1;
    }
  }

  const server = createServer((req, res) => {
    void decide(req).then((result) => {
      if (res.destroyed || res.socket?.destroyed) return; // the client left during the session check
      if (result instanceof Response) return writeResponse(res, result);
      forwardHttp(result, res, idleMs);
    }).catch(() => res.destroy());
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    // Read the socket while the session is checked, so a client that leaves is noticed (a paused socket
    // never sees EOF). Bytes sent before the 101 are kept, bounded, and replayed to the upstream.
    const buffered: Buffer[] = [];
    let bufferedBytes = 0;
    const onData = (chunk: Buffer) => {
      bufferedBytes += chunk.length;
      if (bufferedBytes > 64 * 1024) return void socket.destroy();
      buffered.push(chunk);
    };
    socket.on("data", onData);
    const leftEarly = () => socket.destroy();
    socket.on("end", leftEarly);
    // Admitted: stop buffering and hand half-close handling to pipeSockets.
    const early = () => { socket.off("data", onData); socket.off("end", leftEarly); return Buffer.concat(buffered); };
    // WebSocket only, and no body on the upgrade request (Cloudflare only ever handed the worker these).
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || bodyLength(req) !== undefined) {
      return void writeSocketResponse(socket, jsonError(400, "Bad request"));
    }
    void decide(req).then((result) => {
      if (result instanceof Response) return writeSocketResponse(socket, result);
      forwardUpgrade(result, socket, head, handshakeMs, open, early);
    }).catch(() => socket.destroy());
  });
  upgradedSockets.set(server, open);
  return server;
}

/** Stops accepting, then closes open WebSockets (net.Server would otherwise wait on them forever). */
export function closeNodeIngress(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
    for (const socket of upgradedSockets.get(server) ?? []) socket.destroy();
  });
}
