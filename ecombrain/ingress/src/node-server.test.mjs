import assert from "node:assert/strict";
import { createServer, globalAgent, request } from "node:http";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";

import { relayServiceHeaders } from "./handler.ts";
import { createNodeIngress } from "./node-server.ts";

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
