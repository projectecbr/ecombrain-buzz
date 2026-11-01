/**
 * Node transport for the Teams ingress, for hosts without Cloudflare Containers (a VPS behind a tunnel).
 * Every auth and routing decision stays in handler.ts: this file only turns node:http requests into
 * WHATWG Requests, runs the same handler, and carries the handler's rewritten request to a local
 * upstream (relay or identity bridge). WebSocket upgrades are piped only after the handler admitted them.
 */
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Readable, Transform } from "node:stream";
import { createIngressHandler, type IngressEnv } from "./handler.ts";

export type NodeIngressOptions = {
  /** Secrets and product URL, exactly as the worker reads them. */
  env: Omit<IngressEnv, "RELAY" | "IDENTITY_BRIDGE">;
  /** Local origins, for example http://127.0.0.1:3000. Plain HTTP on loopback or a private network only. */
  relayUpstream: string;
  identityBridgeUpstream: string;
  /** The public origin the tunnel serves; only the path of an incoming request is used. */
  publicOrigin: string;
  maxBodyBytes?: number;
  fetcher?: typeof fetch;
};

type Target = { upstream: URL; request: Request };

const DEFAULT_MAX_BODY = 100 * 1024 * 1024; // the Workers request body limit the worker ran under
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"];
const ADMITTED = new Response(null, { status: 204 });

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** A container namespace whose fetch only records where the handler sent the request. */
function capture(upstream: URL, sink: { target: Target | null }) {
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

/** Builds the WHATWG request; null when the request target is not origin-form or the body is too large. */
function toRequest(message: IncomingMessage, publicOrigin: URL, maxBytes: number): Request | Response {
  if (!message.url?.startsWith("/") || message.url.startsWith("//")) return jsonError(400, "Bad request");
  const declared = Number(message.headers["content-length"] ?? 0);
  if (!Number.isFinite(declared) || declared > maxBytes) return jsonError(413, "Payload too large");
  const method = message.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers: headersOf(message), redirect: "manual" };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(message.pipe(limit(maxBytes))) as ReadableStream;
    init.duplex = "half";
  }
  return new Request(new URL(message.url, publicOrigin), init);
}

function upstreamOptions(target: Target, keepUpgrade: boolean) {
  const url = new URL(target.request.url);
  const headers: Record<string, string> = {};
  target.request.headers.forEach((value, name) => {
    if (!keepUpgrade && HOP_BY_HOP.includes(name)) return;
    headers[name] = value;
  });
  return {
    protocol: target.upstream.protocol,
    hostname: target.upstream.hostname,
    port: target.upstream.port,
    method: target.request.method,
    path: `${url.pathname}${url.search}`,
    headers, // carries the handler's Host (the session-bound community host)
  };
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function writeSocketResponse(socket: Duplex, response: Response): Promise<void> {
  const body = Buffer.from(await response.arrayBuffer());
  const lines = [`HTTP/1.1 ${response.status} ${response.statusText || "Error"}`];
  response.headers.forEach((value, name) => lines.push(`${name}: ${value}`));
  lines.push(`content-length: ${body.length}`, "connection: close", "", "");
  socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

function forwardHttp(target: Target, res: ServerResponse): void {
  const upstream = httpRequest(upstreamOptions(target, false), (upstreamRes) => {
    const headers = { ...upstreamRes.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    res.writeHead(upstreamRes.statusCode ?? 502, headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) void writeResponse(res, jsonError(502, "Teams upstream unavailable"));
    else res.destroy();
  });
  const body = target.request.body;
  if (body) Readable.fromWeb(body as never).on("error", () => upstream.destroy()).pipe(upstream);
  else upstream.end();
}

function forwardUpgrade(target: Target, socket: Duplex, head: Buffer): void {
  const upstream = httpRequest(upstreamOptions(target, true));
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    const lines = [`HTTP/1.1 101 ${upstreamRes.statusMessage || "Switching Protocols"}`];
    for (let i = 0; i < upstreamRes.rawHeaders.length; i += 2) lines.push(`${upstreamRes.rawHeaders[i]}: ${upstreamRes.rawHeaders[i + 1]}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
    // Either side ending, closing or failing tears both down: node:http sockets allow half-open, so an
    // ended client would otherwise keep its upstream socket alive forever.
    const teardown = () => { socket.destroy(); upstreamSocket.destroy(); };
    for (const side of [socket, upstreamSocket]) for (const event of ["end", "close", "error"]) side.on(event, teardown);
  });
  upstream.on("response", (upstreamRes) => {
    // The upstream refused the upgrade: pass its answer through and close.
    const chunks: Buffer[] = [];
    upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
    upstreamRes.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (typeof value === "string" && !HOP_BY_HOP.includes(name) && name !== "content-length") headers.set(name, value);
      }
      void writeSocketResponse(socket, new Response(Buffer.concat(chunks), { status: upstreamRes.statusCode ?? 502, headers }));
    });
  });
  upstream.on("error", () => void writeSocketResponse(socket, jsonError(502, "Teams upstream unavailable")));
  upstream.end();
}

export function createNodeIngress(options: NodeIngressOptions): Server {
  const handle = createIngressHandler(options.fetcher ?? fetch);
  const publicOrigin = new URL(options.publicOrigin);
  const relay = new URL(options.relayUpstream);
  const bridge = new URL(options.identityBridgeUpstream);
  const maxBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  async function decide(message: IncomingMessage): Promise<Target | Response> {
    const request = toRequest(message, publicOrigin, maxBytes);
    if (request instanceof Response) return request;
    const sink: { target: Target | null } = { target: null };
    const env = { ...options.env, RELAY: capture(relay, sink), IDENTITY_BRIDGE: capture(bridge, sink) } as IngressEnv;
    let response: Response;
    try {
      response = await handle(request, env);
    } catch {
      return jsonError(400, "Bad request"); // includes a body over the limit while the handler hashed it
    }
    return response === ADMITTED && sink.target ? sink.target : response;
  }

  const server = createServer((req, res) => {
    void decide(req).then((result) => {
      if (result instanceof Response) return writeResponse(res, result);
      forwardHttp(result, res);
    }).catch(() => res.destroy());
  });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    void decide(req).then((result) => {
      if (result instanceof Response) return writeSocketResponse(socket, result);
      forwardUpgrade(result, socket, head);
    }).catch(() => socket.destroy());
  });
  return server;
}
