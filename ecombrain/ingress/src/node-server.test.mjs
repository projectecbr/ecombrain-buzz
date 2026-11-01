import assert from "node:assert/strict";
import { createServer, globalAgent, request } from "node:http";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";

import { relayServiceHeaders } from "./handler.ts";
import { closeNodeIngress, createNodeIngress } from "./node-server.ts";

// Placeholders only: no real hosts, keys or tokens.
const token = "a".repeat(43);
const secret = "s".repeat(32);
const relayServiceSecret = "r".repeat(32);
const communityHost = "tenant-1.teams.example.internal";
const communityId = "11111111-1111-4111-8111-111111111111";

function upstreamServer(name) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({ kind: "http", method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { "content-type": "text/plain", connection: "keep-alive" });
      res.end(`${name} ok`);
    });
  });
  server.on("upgrade", (req, socket) => {
    seen.push({ kind: "upgrade", url: req.url, headers: req.headers });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk) => socket.write(Buffer.concat([Buffer.from(`${name}:`), chunk])));
    socket.on("end", () => socket.destroy());
  });
  return { server, seen };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const relay = upstreamServer("relay");
const bridge = upstreamServer("bridge");
let productCalls = 0;
let ingress;
let port;

async function product(url) {
  productCalls += 1;
  const path = new URL(url).pathname;
  if (path === "/api/internal/teams/ingress/session") return Response.json({ communityHost });
  if (path === "/api/internal/teams/ingress/service") return Response.json({ communityHost });
  return new Response(null, { status: 404 });
}

function call(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Raw upgrade: returns the status line and a send(text) that resolves the echoed reply. */
function upgrade(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const lines = [`GET ${path} HTTP/1.1`, "Host: teams.example.test", "Upgrade: websocket", "Connection: Upgrade",
      "Sec-WebSocket-Version: 13", `Sec-WebSocket-Key: ${Buffer.from("test-nonce-0000").toString("base64")}`];
    for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    socket.once("data", (chunk) => {
      const text = chunk.toString();
      resolve({
        status: Number(text.split(" ")[1]),
        text,
        send: (message) => new Promise((done) => { socket.once("data", (reply) => done(reply.toString())); socket.write(message); }),
        close: () => socket.destroy(),
      });
    });
    socket.on("error", reject);
  });
}

before(async () => {
  const relayPort = await listen(relay.server);
  const bridgePort = await listen(bridge.server);
  ingress = createNodeIngress({
    env: {
      TEAMS_INGRESS_SERVICE_SECRET: secret,
      TEAMS_PRODUCT_API_URL: "https://app.example.test",
      TEAMS_RELAY_SERVICE_SECRET: relayServiceSecret,
      TEAMS_OPERATOR_SERVICE_SECRET: "o".repeat(32),
      TEAMS_BUNKER_PUBKEY: "b".repeat(64),
    },
    relayUpstream: `http://127.0.0.1:${relayPort}`,
    identityBridgeUpstream: `http://127.0.0.1:${bridgePort}`,
    publicOrigin: "https://teams.example.test",
    maxBodyBytes: 1024,
    fetcher: product,
  });
  port = await listen(ingress);
});

after(() => {
  globalAgent.destroy(); // pooled keep-alive sockets (test client and the ingress's upstream calls)
  for (const server of [ingress, relay.server, bridge.server]) {
    server.closeAllConnections();
    server.close();
  }
});

const cookie = `ecombrain_teams_session=${token}`;

describe("Teams ingress on Node", () => {
  it("refuses a relay request without a session and never reaches the product or relay", async () => {
    const before = { product: productCalls, relay: relay.seen.length };
    const response = await call("/teams/relay/media/x");
    assert.equal(response.status, 401);
    assert.equal(productCalls, before.product);
    assert.equal(relay.seen.length, before.relay);
  });

  it("forwards a session request to the bound community host with spoofing headers stripped", async () => {
    const response = await call("/teams/relay/api/x?y=1", {
      method: "POST",
      headers: { cookie, "x-tenant-id": "other", "x-teams-tenant": "other", "x-forwarded-host": "evil.test", "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(response.status, 200);
    assert.equal(response.body, "relay ok");
    const seen = relay.seen.at(-1);
    assert.equal(seen.url, "/api/x?y=1");
    assert.equal(seen.headers.host, communityHost);
    assert.equal(seen.body, "hello");
    for (const name of ["cookie", "x-tenant-id", "x-teams-tenant", "x-forwarded-host"]) assert.equal(seen.headers[name], undefined);
  });

  it("pipes an admitted relay WebSocket to the bound host and back", async () => {
    const socket = await upgrade("/teams/relay", { Cookie: cookie, "X-Tenant-Id": "other" });
    assert.equal(socket.status, 101);
    assert.equal(await socket.send("ping"), "relay:ping");
    socket.close();
    const seen = relay.seen.at(-1);
    assert.equal(seen.kind, "upgrade");
    assert.equal(seen.headers.host, communityHost);
    assert.equal(seen.headers.cookie, undefined);
    assert.equal(seen.headers["x-tenant-id"], undefined);
  });

  it("refuses a WebSocket without a session and never opens the upstream", async () => {
    const before = relay.seen.length;
    const socket = await upgrade("/teams/relay");
    assert.equal(socket.status, 401);
    socket.close();
    assert.equal(relay.seen.length, before);
  });

  it("routes the bunker socket to the identity bridge only", async () => {
    const before = relay.seen.length;
    const socket = await upgrade("/teams/bunker", { Cookie: cookie });
    assert.equal(socket.status, 101);
    assert.equal(await socket.send("sign"), "bridge:sign");
    socket.close();
    assert.equal(relay.seen.length, before);
    assert.equal(bridge.seen.at(-1).headers.cookie, undefined);
  });

  it("admits a signed service request and refuses a forged one", async () => {
    const body = JSON.stringify({ kind: 9 });
    const url = "https://teams.example.test/teams/service/relay/events";
    const derived = (await import("node:crypto")).createHmac("sha256", relayServiceSecret)
      .update(`teams-relay-service:identity:${communityId}`).digest("hex");
    const headers = await relayServiceHeaders({ serviceSecret: derived, service: "identity", communityId, method: "POST", url, body });
    const ok = await call("/teams/service/relay/events", { method: "POST", headers, body });
    assert.equal(ok.status, 200);
    assert.equal(relay.seen.at(-1).headers.host, communityHost);
    const forged = await call("/teams/service/relay/events", { method: "POST", headers: { ...headers, "X-Teams-Relay-Authorization": `Teams-HMAC ${"0".repeat(64)}` }, body });
    assert.equal(forged.status, 401);
  });

  it("rejects absolute-form targets, oversize bodies and unknown paths", async () => {
    const absolute = await new Promise((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.write("GET http://evil.test/teams/relay HTTP/1.1\r\nHost: evil.test\r\nConnection: close\r\n\r\n");
      socket.once("data", (chunk) => { resolve(Number(chunk.toString().split(" ")[1])); socket.destroy(); });
    });
    assert.equal(absolute, 400);
    const big = await call("/teams/relay/x", { method: "POST", headers: { cookie, "content-length": "2048" }, body: "x".repeat(2048) });
    assert.equal(big.status, 413);
    assert.equal((await call("/elsewhere")).status, 404);
  });

  it("answers 502 when the upstream is down", async () => {
    const dead = createNodeIngress({
      env: { TEAMS_INGRESS_SERVICE_SECRET: secret, TEAMS_PRODUCT_API_URL: "https://app.example.test", TEAMS_RELAY_SERVICE_SECRET: relayServiceSecret,
        TEAMS_OPERATOR_SERVICE_SECRET: "o".repeat(32), TEAMS_BUNKER_PUBKEY: "b".repeat(64) },
      relayUpstream: "http://127.0.0.1:9", identityBridgeUpstream: "http://127.0.0.1:9",
      publicOrigin: "https://teams.example.test", fetcher: product,
    });
    const deadPort = await listen(dead);
    const response = await new Promise((resolve) => {
      request({ host: "127.0.0.1", port: deadPort, path: "/teams/relay/x", headers: { cookie } }, (res) => resolve(res.statusCode)).end();
    });
    dead.closeAllConnections();
    dead.close();
    assert.equal(response, 502);
  });
});

// Gate 66be6e1e findings (OPUS1 + OPUS2): framing, teardown, service body cap. Each case failed on that sha.
describe("Teams ingress on Node: framing and teardown", () => {
  const probe = { requests: [], closed: 0, upgrades: 0, silentOpen: 0 };
  let probeServer;
  let silentServer;
  let fast;
  let fastPort;

  function raw(text, targetPort = fastPort) {
    return new Promise((resolve) => {
      const socket = connect(targetPort, "127.0.0.1");
      const chunks = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
      socket.write(text);
      setTimeout(() => socket.destroy(), 400);
    });
  }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const auth = `Host: teams.example.test\r\nCookie: ${cookie}\r\n`;

  before(async () => {
    probeServer = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("close", () => { probe.closed += 1; });
      if (req.url === "/stream") {
        res.writeHead(200);
        const timer = setInterval(() => res.write("tick"), 20);
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (req.url === "/upload") return; // reads the body forever, never answers
      req.on("end", () => {
        probe.requests.push({ method: req.method, url: req.url, host: req.headers.host, length: req.headers["content-length"], body: Buffer.concat(chunks).toString() });
        res.end("ok");
      });
    });
    probeServer.on("upgrade", (req, socket) => {
      probe.upgrades += 1;
      if (req.url !== "/halfclose") return;
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("end", () => setTimeout(() => socket.end("late reply"), 100)); // answers after the client half-closed
    });
    silentServer = (await import("node:net")).createServer((socket) => {
      probe.silentOpen += 1;
      socket.on("close", () => { probe.silentOpen -= 1; });
      socket.resume(); // read, so the peer closing is seen
      socket.on("error", () => {});
    });
    const probePort = await listen(probeServer);
    const silentPort = await listen(silentServer);
    fast = createNodeIngress({
      env: { TEAMS_INGRESS_SERVICE_SECRET: secret, TEAMS_PRODUCT_API_URL: "https://app.example.test", TEAMS_RELAY_SERVICE_SECRET: relayServiceSecret,
        TEAMS_OPERATOR_SERVICE_SECRET: "o".repeat(32), TEAMS_BUNKER_PUBKEY: "b".repeat(64) },
      relayUpstream: `http://127.0.0.1:${probePort}`,
      identityBridgeUpstream: `http://127.0.0.1:${silentPort}`,
      publicOrigin: "https://teams.example.test",
      maxBodyBytes: 4096,
      maxServiceBodyBytes: 1024,
      upgradeHandshakeMs: 300,
      upstreamIdleMs: 1_000,
      fetcher: async (url) => {
        await wait(new URL(url).pathname.endsWith("/session") && slowSession ? 200 : 0);
        return product(url);
      },
    });
    fastPort = await listen(fast);
  });
  let slowSession = false;

  after(async () => {
    await closeNodeIngress(fast);
    for (const server of [probeServer, silentServer]) {
      server.closeAllConnections?.();
      server.close();
    }
  });

  for (const method of ["DELETE", "OPTIONS"]) {
    it(`frames a chunked ${method} body so a smuggled request never reaches the relay`, async () => {
      const smuggled = "GET /admin/export HTTP/1.1\r\nHost: tenant-b.teams.example.internal\r\n\r\n";
      const before = probe.requests.length;
      const chunk = `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`;
      await raw(`${method} /teams/relay/x HTTP/1.1\r\n${auth}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk}`);
      await wait(100);
      const seen = probe.requests.slice(before);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].method, method);
      assert.equal(seen[0].host, communityHost);
      assert.equal(seen[0].body, smuggled);
      assert.ok(!probe.requests.some((request) => request.url === "/admin/export"));
    });
  }

  it("drops a GET body together with its length", async () => {
    const before = probe.requests.length;
    await raw(`GET /teams/relay/first HTTP/1.1\r\n${auth}Content-Length: 40\r\nConnection: close\r\n\r\n${"x".repeat(40)}`);
    await wait(100);
    const seen = probe.requests.slice(before);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].length, undefined);
    assert.equal(seen[0].body, "");
  });

  it("refuses upgrades that carry a body or are not WebSocket", async () => {
    const before = probe.upgrades;
    const withBody = await raw(`GET /teams/relay HTTP/1.1\r\n${auth}Upgrade: websocket\r\nConnection: Upgrade\r\nContent-Length: 7\r\n\r\nPAYLOAD`);
    const h2c = await raw(`GET /teams/relay HTTP/1.1\r\n${auth}Upgrade: h2c\r\nConnection: Upgrade\r\n\r\n`);
    assert.match(withBody, /^HTTP\/1\.1 400 /);
    assert.match(h2c, /^HTTP\/1\.1 400 /);
    assert.equal(probe.upgrades, before);
  });

  it("caps signed service bodies before the handler buffers them", async () => {
    const productBefore = productCalls;
    // Every service header well formed, the signature wrong: the handler would hash the body before refusing.
    const headers = await relayServiceHeaders({ serviceSecret: "w".repeat(64), service: "identity", communityId, method: "POST",
      url: "https://teams.example.test/teams/service/relay/events", body: "{}" });
    const head = Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type").map(([name, value]) => `${name}: ${value}\r\n`).join("");
    const declared = await raw(`POST /teams/service/relay/events HTTP/1.1\r\nHost: teams.example.test\r\n${head}Content-Length: 2048\r\nConnection: close\r\n\r\n${"x".repeat(2048)}`);
    assert.match(declared, /^HTTP\/1\.1 413 /);
    const chunk = "x".repeat(2048);
    const streamed = await raw(`POST /teams/service/relay/events HTTP/1.1\r\nHost: teams.example.test\r\n${head}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`);
    assert.match(streamed, /^HTTP\/1\.1 413 /);
    assert.equal(productCalls, productBefore);
  });

  it("answers 413 when a streamed relay body passes the cap", async () => {
    const chunk = "x".repeat(5000);
    const response = await raw(`POST /teams/relay/x HTTP/1.1\r\n${auth}Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk.length.toString(16)}\r\n${chunk}\r\n0\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 413 /);
  });

  it("closes the upstream when the client leaves a streaming response", async () => {
    const before = probe.closed;
    await raw(`GET /teams/relay/stream HTTP/1.1\r\n${auth}\r\n`);
    await wait(300);
    assert.equal(probe.closed, before + 1);
  });

  it("closes the upstream when the client drops mid-upload", async () => {
    const before = probe.closed;
    await raw(`POST /teams/relay/upload HTTP/1.1\r\n${auth}Content-Length: 1000\r\n\r\nabc`);
    await wait(300);
    assert.equal(probe.closed, before + 1);
  });

  it("opens no upstream for a WebSocket that left during the session check", async () => {
    slowSession = true;
    const before = probe.upgrades;
    const socket = connect(fastPort, "127.0.0.1");
    socket.write(`GET /teams/relay HTTP/1.1\r\n${auth}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    await wait(50);
    socket.destroy();
    await wait(400);
    slowSession = false;
    assert.equal(probe.upgrades, before);
  });

  it("times out an upgrade the upstream never answers, and frees its socket", async () => {
    const response = await new Promise((resolve) => {
      const socket = connect(fastPort, "127.0.0.1");
      const chunks = [];
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
      socket.write(`GET /teams/bunker HTTP/1.1\r\n${auth}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    assert.match(response, /^HTTP\/1\.1 504 Gateway Timeout/);
    await wait(100);
    assert.equal(probe.silentOpen, 0);
  });

  it("caps service bodies on the normalised path, as the handler routes them", async () => {
    const headers = await relayServiceHeaders({ serviceSecret: "w".repeat(64), service: "identity", communityId, method: "POST",
      url: "https://teams.example.test/teams/service/relay/events", body: "{}" });
    const head = Object.entries(headers).filter(([name]) => name.toLowerCase() !== "content-type").map(([name, value]) => `${name}: ${value}\r\n`).join("");
    for (const path of ["/teams/relay/../service/relay/events", "/teams/relay/%2e%2e/service/relay/events"]) {
      const response = await raw(`POST ${path} HTTP/1.1\r\nHost: teams.example.test\r\n${head}Content-Length: 2048\r\nConnection: close\r\n\r\n${"x".repeat(2048)}`);
      assert.match(response, /^HTTP\/1\.1 413 /, path);
    }
  });

  it("keeps the bound Host when the client lists Host in Connection", async () => {
    const before = probe.requests.length;
    await raw(`GET /teams/relay/h HTTP/1.1\r\n${auth}Connection: host, close\r\n\r\n`);
    await wait(100);
    assert.equal(probe.requests.slice(before)[0].host, communityHost);
  });

  it("delivers the upstream reply after the client half-closes a WebSocket", async () => {
    const received = await new Promise((resolve) => {
      const socket = connect(fastPort, "127.0.0.1", { allowHalfOpen: true });
      const chunks = [];
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        if (chunks.length === 1) socket.end(); // half-close right after the 101
      });
      socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
      socket.write(`GET /teams/relay/halfclose HTTP/1.1\r\n${auth}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    assert.match(received, /^HTTP\/1\.1 101 /);
    assert.match(received, /late reply$/);
  });

  it("rejects backslash targets", async () => {
    assert.match(await raw(`GET /\\evil.test/teams/relay/x HTTP/1.1\r\n${auth}Connection: close\r\n\r\n`), /^HTTP\/1\.1 400 /);
  });

  it("closes open WebSockets on shutdown", async () => {
    const own = createNodeIngress({
      env: { TEAMS_INGRESS_SERVICE_SECRET: secret, TEAMS_PRODUCT_API_URL: "https://app.example.test", TEAMS_RELAY_SERVICE_SECRET: relayServiceSecret,
        TEAMS_OPERATOR_SERVICE_SECRET: "o".repeat(32), TEAMS_BUNKER_PUBKEY: "b".repeat(64) },
      relayUpstream: `http://127.0.0.1:${relay.server.address().port}`, identityBridgeUpstream: `http://127.0.0.1:${bridge.server.address().port}`,
      publicOrigin: "https://teams.example.test", fetcher: product,
    });
    const ownPort = await listen(own);
    const closed = new Promise((resolve) => {
      const socket = connect(ownPort, "127.0.0.1");
      socket.on("close", resolve);
      socket.once("data", () => void closeNodeIngress(own));
      socket.write(`GET /teams/relay HTTP/1.1\r\n${auth}Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    await Promise.race([closed, wait(2_000).then(() => assert.fail("socket still open after shutdown"))]);
  });
});
