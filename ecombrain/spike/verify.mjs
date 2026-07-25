#!/usr/bin/env node
/**
 * verify.mjs — Phase 0 Cloudflare feasibility spike verification for the Buzz relay
 * (github.com/block/buzz, fork projectecbr/ecombrain-buzz, branch ecombrain/phase0-spike,
 * pinned tag relay-v0.2.0).
 *
 * Exercises the relay API contract against the spike deployment on Cloudflare
 * (worker + containers): operator community provisioning (NIP-98), tenant
 * fail-closed binding, NIP-01/NIP-42 WebSocket roundtrip, Blossom media
 * upload/download with cross-tenant isolation, edge latency bench, and a
 * long-running WS soak.
 *
 * API shapes were verified against the fork's Rust source (see mismatch notes
 * at the bottom of this header):
 *   - Operator provisioning: POST /operator/communities, NIP-98 kind:27235 with
 *     u/method/payload tags, URL bound to RELAY_OPERATOR_API_ORIGIN
 *     (crates/buzz-relay/src/api/operator.rs:41-83, :130-172).
 *   - Media: PUT /media/upload (Blossom BUD-02/11, kind:24242 auth event,
 *     X-SHA-256 header, raw bytes body, returns BlobDescriptor JSON) and
 *     GET /media/{sha256_ext} (crates/buzz-relay/src/api/media.rs:258-385,
 *     :508-545, router.rs:38-42). NOT /upload.
 *   - Event publish: WS NIP-01 EVENT frame is used here (REST POST /events
 *     with NIP-98 also exists, bridge.rs:557-646 — not used).
 *   - WS: NIP-01 at / with mandatory NIP-42 auth (challenge on connect, 5s
 *     timeout, kind:22242 AUTH event with relay+challenge tags; REQ/EVENT are
 *     rejected unauthenticated) — connection.rs:26-27, handlers/req.rs:76-85,
 *     handlers/event.rs:600-601, handlers/auth.rs:339.
 *   - GET /media is unauthenticated but tenant-sidecar gated: a blob uploaded
 *     under tenant A 404s when requested with tenant B's Host
 *     (media.rs:514-543, buzz-media/src/auth.rs:92-121).
 *
 * Secrets come from Doppler (project ecombrain, config stg_teams). NEVER
 * hardcode secrets in this file. Run:
 *
 *   doppler run --project ecombrain --config stg_teams -- node verify.mjs <subcommand>
 *
 * Env vars:
 *   SPIKE_BASE                 (default https://ecombrain-teams-spike.coveandlinen.workers.dev)
 *   OPERATOR_NSEC              hex (or nsec1...) secret key — operator API + event signing
 *   RELAY_OPERATOR_API_ORIGIN  (default = SPIKE_BASE) NIP-98 u-tag origin for operator API
 *   SPIKE_TENANT_HOST          (default tenant-spike.teams.ecombrain.internal)
 *   SPIKE_TENANT_HOST_2        (default tenant-other.teams.ecombrain.internal)
 *   SPIKE_STATUS_PATH          (default /_status — see bench note below)
 *
 * Subcommands: provision | roundtrip [n] | media | bench | soak [--duration N]
 * Every check prints `RESULT <sub> <check> PASS|FAIL k=v...`; exit != 0 on any FAIL.
 *
 * Known deviations from the original spike plan (source-verified, relay-v0.2.0):
 *   - Media upload route is PUT /media/upload, not POST /upload (router.rs:38).
 *   - /_status exists only on the health router (port 8080, router.rs:149-155);
 *     the app router serves /health (router.rs:56). bench hits SPIKE_STATUS_PATH
 *     anyway — any HTTP status still measures edge RTT.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';

// ---------- config ----------

const SPIKE_BASE = (process.env.SPIKE_BASE || 'https://ecombrain-teams-spike.coveandlinen.workers.dev').replace(/\/+$/, '');
const OPERATOR_ORIGIN = (process.env.RELAY_OPERATOR_API_ORIGIN || SPIKE_BASE).replace(/\/+$/, '');
const TENANT_1 = process.env.SPIKE_TENANT_HOST || 'tenant-spike.teams.ecombrain.internal';
const TENANT_2 = process.env.SPIKE_TENANT_HOST_2 || 'tenant-other.teams.ecombrain.internal';
const STATUS_PATH = process.env.SPIKE_STATUS_PATH || '/_status';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function result(sub, check, pass, detail = '') {
  if (!pass) failures++;
  console.log(`RESULT ${sub} ${check} ${pass ? 'PASS' : 'FAIL'}${detail ? ' ' + detail : ''}`);
}

function loadOperatorKey() {
  const raw = (process.env.OPERATOR_NSEC || '').trim();
  if (!raw) { console.error('OPERATOR_NSEC is required (hex or nsec1..., from Doppler stg_teams)'); process.exit(2); }
  if (raw.startsWith('nsec1')) {
    const { type, data } = nip19.decode(raw);
    if (type !== 'nsec') { console.error('OPERATOR_NSEC: not an nsec'); process.exit(2); }
    return data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) { console.error('OPERATOR_NSEC: expected 64-char hex'); process.exit(2); }
  return Uint8Array.from(Buffer.from(raw, 'hex'));
}

// ---------- small helpers ----------

const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}
function pstats(values) {
  const s = [...values].sort((a, b) => a - b);
  return { p50: percentile(s, 50), p95: percentile(s, 95) };
}
const fmt = (ms) => (Number.isFinite(ms) ? `${ms.toFixed(1)}ms` : 'n/a');

// ---------- nostr auth builders (match relay source exactly) ----------

// NIP-98 kind:27235 — tags u, method, payload(sha256 hex of body); base64(std) JSON.
// buzz-auth/src/nip98.rs:55-130; ±60s created_at window.
function nip98Header(sk, url, method, body) {
  const tags = [['u', url], ['method', method]];
  if (body) tags.push(['payload', sha256hex(body)]);
  const ev = finalizeEvent({ kind: 27235, created_at: nowSecs(), tags, content: '' }, sk);
  return `Nostr ${b64(JSON.stringify(ev))}`;
}

// Blossom BUD-11 kind:24242 — t=upload, x=sha256, expiration>now, non-empty content.
// buzz-media/src/auth.rs:15-124. server tag is matched against the bound tenant host.
function blossomHeader(sk, tenantHost, hashHex) {
  const tags = [
    ['t', 'upload'],
    ['x', hashHex],
    ['expiration', String(nowSecs() + 300)],
    ['server', tenantHost],
  ];
  const ev = finalizeEvent({ kind: 24242, created_at: nowSecs(), tags, content: 'spike media upload' }, sk);
  return `Nostr ${b64(JSON.stringify(ev))}`;
}

// NIP-42 kind:22242 — relay tag = wss://<tenant host> (bridge.rs:191-198), challenge tag.
function nip42AuthEvent(sk, tenantHost, challenge) {
  const wsScheme = SPIKE_BASE.startsWith('https:') ? 'wss' : 'ws';
  return finalizeEvent({
    kind: 22242,
    created_at: nowSecs(),
    tags: [['relay', `${wsScheme}://${tenantHost}`], ['challenge', challenge]],
    content: '',
  }, sk);
}

// ---------- minimal HTTP(S) client (node:http so Host header is controllable) ----------

function httpReq(method, urlStr, { hostHeader, headers = {}, body = null, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const secure = u.protocol === 'https:';
    const req = (secure ? https : http).request({
      hostname: u.hostname,
      port: u.port || (secure ? 443 : 80),
      path: u.pathname + u.search,
      method,
      servername: u.hostname, // TLS SNI stays the real endpoint; Host header is the tenant
      headers: { Host: hostHeader || u.host, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error(`http timeout after ${timeoutMs}ms`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- minimal RFC6455 client (custom Host header for tenant binding) ----------

function wsConnect(urlStr, hostHeader, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const secure = u.protocol === 'https:' || u.protocol === 'wss:';
    const sock = secure
      ? tls.connect({ host: u.hostname, port: u.port || 443, servername: u.hostname })
      : net.connect({ host: u.hostname, port: u.port || 80 });

    const queue = [];          // decoded text payloads
    const waiters = [];        // pending recv() calls
    let buf = Buffer.alloc(0);
    let frag = null;           // fragmented-message accumulator
    let closed = false;
    let open = false;

    const timer = setTimeout(() => { if (!open) { sock.destroy(); reject(new Error('ws handshake timeout')); } }, timeoutMs);

    const push = (msg) => {
      const w = waiters.shift();
      if (w) { clearTimeout(w.t); w.res(msg); } else queue.push(msg);
    };
    const failAll = (err) => {
      if (closed) return;
      closed = true;
      while (waiters.length) { const w = waiters.shift(); clearTimeout(w.t); w.rej(err); }
    };
    const sendFrame = (opcode, payload) => {
      const len = payload.length;
      let header;
      const mask = randomBytes(4);
      if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
      else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0xFE; header.writeUInt16BE(len, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0xFF; header.writeBigUInt64BE(BigInt(len), 2); }
      const masked = Buffer.from(payload);
      for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
      sock.write(Buffer.concat([header, mask, masked]));
    };

    const onFrame = (fin, opcode, payload) => {
      if (opcode === 0x9) return sendFrame(0xA, payload);            // ping -> pong
      if (opcode === 0x8) { failAll(new Error('ws closed by peer')); try { sock.end(); } catch {} return; }
      if (opcode === 0x0 && frag) { frag = Buffer.concat([frag, payload]); if (fin) { push(frag.toString('utf8')); frag = null; } return; }
      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) return push(payload.toString('utf8'));
        frag = Buffer.from(payload);
      }
    };
    const parse = () => {
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len); // server frames are unmasked
        buf = buf.subarray(off + len);
        onFrame(fin, opcode, payload);
      }
    };

    let handshake = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      if (!open) {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = handshake.subarray(0, end).toString('latin1');
        if (!/^HTTP\/1\.1 101/.test(head)) {
          clearTimeout(timer);
          sock.destroy();
          return reject(new Error(`ws upgrade rejected: ${head.split('\r\n')[0]}`));
        }
        open = true;
        clearTimeout(timer);
        buf = handshake.subarray(end + 4);
        resolve(conn);
        parse();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      parse();
    });
    sock.on('error', (e) => { clearTimeout(timer); if (!open) reject(e); failAll(e); });
    sock.on('close', () => failAll(new Error('ws closed')));

    sock.on(secure ? 'secureConnect' : 'connect', () => {
      const key = randomBytes(16).toString('base64');
      sock.write(
        `GET ${u.pathname || '/'} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });

    const conn = {
      send: (s) => sendFrame(0x1, Buffer.from(s, 'utf8')),
      recv: (ms = 5000) => new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        if (closed) return rej(new Error('ws closed'));
        const w = { res, rej, t: setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); rej(new Error(`recv timeout ${ms}ms`)); }, ms) };
        waiters.push(w);
      }),
      close: () => { try { sendFrame(0x8, Buffer.alloc(0)); sock.end(); } catch {} failAll(new Error('ws closed')); },
      get closed() { return closed; },
    };
  });
}

// NIP-42 handshake: relay sends ["AUTH", challenge] on connect; answer with kind:22242.
async function wsAuthed(tenantHost, sk) {
  const ws = await wsConnect(SPIKE_BASE + '/', tenantHost);
  const hello = JSON.parse(await ws.recv(5000));
  if (hello[0] !== 'AUTH') throw new Error(`expected AUTH challenge, got ${JSON.stringify(hello).slice(0, 120)}`);
  const authEv = nip42AuthEvent(sk, tenantHost, hello[1]);
  ws.send(JSON.stringify(['AUTH', authEv]));
  for (;;) {
    const msg = JSON.parse(await ws.recv(5000));
    if (msg[0] === 'OK' && msg[1] === authEv.id) {
      if (msg[2] !== true) throw new Error(`NIP-42 rejected: ${msg[3] || ''}`);
      return ws;
    }
  }
}

// Operator provisioning: POST /operator/communities, NIP-98 u = ORIGIN + path
// (operator.rs:54-58 — NOT the tenant host). Converge mode (no create_only) is idempotent.
async function provisionCommunity(tenantHost, sk, ownerHex) {
  const path_ = '/operator/communities';
  const body = Buffer.from(JSON.stringify({ host: tenantHost, initial_owner_pubkey: ownerHex }));
  const res = await httpReq('POST', SPIKE_BASE + path_, {
    hostHeader: new URL(OPERATOR_ORIGIN).host,
    headers: {
      Authorization: nip98Header(sk, OPERATOR_ORIGIN + path_, 'POST', body),
      'Content-Type': 'application/json',
    },
    body,
  });
  let json = {};
  try { json = JSON.parse(res.body.toString('utf8')); } catch {}
  return { status: res.status, json };
}

// ---------- subcommands ----------

async function cmdProvision(sk) {
  const ownerHex = getPublicKey(sk);
  const run1 = await provisionCommunity(TENANT_1, sk, ownerHex);
  console.log(`run1 http=${run1.status} body=${JSON.stringify(run1.json)}`);
  // NIP-98 has no nonce: identical request within the same second => identical
  // event id => relay replay guard fires. Space the two runs across a second.
  await new Promise((r) => setTimeout(r, 1100));
  const run2 = await provisionCommunity(TENANT_1, sk, ownerHex);
  console.log(`run2 http=${run2.status} body=${JSON.stringify(run2.json)}`);
  const ok1 = run1.status === 200 && ['created', 'existed'].includes(run1.json.status);
  const ok2 = run2.status === 200 && run2.json.status === 'existed';
  result('provision', 'idempotent-2x', ok1 && ok2, `run1=${run1.json.status || run1.status} run2=${run2.json.status || run2.status}`);

  // Negative: unprovisioned Host must fail closed (router.rs:190-202 -> 404 generic).
  const bogus = `unprovisioned-${randomUUID().slice(0, 8)}.teams.ecombrain.internal`;
  const res = await httpReq('GET', SPIKE_BASE + '/', { hostHeader: bogus, timeoutMs: 15000 });
  const failClosed = res.status === 404;
  result('provision', 'unprovisioned-tenant-404', failClosed, `http=${res.status} host=${bogus}`);
}

async function cmdRoundtrip(sk, n) {
  const a = await wsAuthed(TENANT_1, sk);
  const b = await wsAuthed(TENANT_1, sk);
  const pubB = getPublicKey(sk);
  a.send(JSON.stringify(['REQ', 'spike-rt', { kinds: [1], authors: [pubB] }]));
  for (;;) { // drain until EOSE (subscription live)
    const msg = JSON.parse(await a.recv(8000));
    if (msg[0] === 'EOSE' && msg[1] === 'spike-rt') break;
    if (msg[0] === 'CLOSED') throw new Error(`subscription closed: ${msg[2] || ''}`);
  }
  const lat = [];
  let failed = 0;
  for (let i = 0; i < n; i++) {
    const ev = finalizeEvent({ kind: 1, created_at: nowSecs(), tags: [], content: `spike-rt ${i} ${randomUUID()}` }, sk);
    const t0 = performance.now();
    b.send(JSON.stringify(['EVENT', ev]));
    let okRecv = false, delivered = false;
    const deadline = t0 + 2000;
    while (performance.now() < deadline && !(okRecv && delivered)) {
      const left = deadline - performance.now();
      try {
        if (!okRecv) {
          const m = JSON.parse(await b.recv(left));
          if (m[0] === 'OK' && m[1] === ev.id) { okRecv = true; if (m[2] !== true) break; }
        } else {
          const m = JSON.parse(await a.recv(left));
          if (m[0] === 'EVENT' && m[2]?.id === ev.id) { delivered = true; lat.push(performance.now() - t0); }
        }
      } catch { break; }
    }
    if (!delivered) failed++;
  }
  a.close(); b.close();
  const { p50, p95 } = pstats(lat);
  console.log(`delivered=${lat.length}/${n} p50=${fmt(p50)} p95=${fmt(p95)}`);
  result('roundtrip', 'delivery', failed === 0, `n=${n} failures=${failed} p50=${fmt(p50)} p95=${fmt(p95)}`);
}

async function uploadBlob(sk, tenantHost, bytes) {
  const hash = sha256hex(bytes);
  const res = await httpReq('PUT', SPIKE_BASE + '/media/upload', {
    hostHeader: tenantHost,
    headers: {
      Authorization: blossomHeader(sk, tenantHost, hash),
      'X-SHA-256': hash,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
    timeoutMs: 120000,
  });
  let json = {};
  try { json = JSON.parse(res.body.toString('utf8')); } catch {}
  return { status: res.status, json, hash };
}

async function cmdMedia(sk) {
  const ownerHex = getPublicKey(sk);
  const oneMb = randomBytes(1024 * 1024);
  const up = await uploadBlob(sk, TENANT_1, oneMb);
  const upOk = up.status === 200 && up.json.sha256 === up.hash;
  result('media', 'upload-1mb', upOk, `http=${up.status} sha256=${up.json.sha256 || 'none'}`);

  // Descriptor url is rewritten to the tenant host (media.rs:348-352); use its path.
  const mediaPath = up.json.url ? new URL(up.json.url).pathname : `/media/${up.hash}`;
  const dl = await httpReq('GET', SPIKE_BASE + mediaPath, { hostHeader: TENANT_1, timeoutMs: 60000 });
  const dlOk = dl.status === 200 && sha256hex(dl.body) === up.hash && dl.body.length === oneMb.length;
  result('media', 'download-sha256', dlOk, `http=${dl.status} bytes=${dl.body.length}`);

  // Cross-tenant gate: provision tenant 2, then GET the same blob with its Host -> must 404
  // (sidecar is per-tenant; media.rs:528-532 NotFound).
  const prov2 = await provisionCommunity(TENANT_2, sk, ownerHex);
  console.log(`tenant2 provision http=${prov2.status} body=${JSON.stringify(prov2.json)}`);
  const xt = await httpReq('GET', SPIKE_BASE + mediaPath, { hostHeader: TENANT_2, timeoutMs: 30000 });
  result('media', 'cross-tenant-404', xt.status === 404, `http=${xt.status}`);

  const twentyMb = randomBytes(20 * 1024 * 1024);
  const big = await uploadBlob(sk, TENANT_1, twentyMb);
  result('media', 'upload-20mb', big.status === 200 && big.json.sha256 === big.hash, `http=${big.status}`);
}

async function cmdBench(sk) {
  const signTimes = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    finalizeEvent({ kind: 1, created_at: nowSecs(), tags: [], content: `bench ${i} ${randomUUID()}` }, sk);
    signTimes.push(performance.now() - t0);
  }
  const rtts = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    try { await httpReq('GET', SPIKE_BASE + STATUS_PATH, { timeoutMs: 15000 }); rtts.push(performance.now() - t0); }
    catch (e) { console.error(`rtt iter ${i} failed: ${e.message}`); }
  }
  const s = pstats(signTimes), r = pstats(rtts);
  console.log(`sign p50=${fmt(s.p50)} p95=${fmt(s.p95)} | rtt(${STATUS_PATH}) n=${rtts.length} p50=${fmt(r.p50)} p95=${fmt(r.p95)}`);
  const combined = s.p95 + r.p95;
  result('bench', 'p95-under-300ms', Number.isFinite(combined) && combined < 300, `sign_p95=${fmt(s.p95)} rtt_p95=${fmt(r.p95)} combined=${fmt(combined)}`);
}

async function cmdSoak(sk, durationSecs) {
  const logPath = path.join(SCRIPT_DIR, `soak-${Math.floor(Date.now() / 1000)}.log`);
  const log = (line) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    appendFileSync(logPath, stamped + '\n');
  };
  log(`soak start duration=${durationSecs}s conns=50 log=${logPath}`);
  let stopping = false;
  const stats = { disconnects: 0, reconOk: 0, reconFail: 0, reconTimes: [], reqLat: [] };

  async function connLoop(id) {
    let keepalives = 0;
    while (!stopping && (keepalives === 0 || Date.now() < stopAt)) {
      let ws;
      try { ws = await wsAuthed(TENANT_1, sk); log(`conn ${id} connect ok`); }
      catch (e) { log(`conn ${id} connect FAIL ${e.message}`); await sleep(2000); continue; }
      let deadAt = 0;
      try {
        while (!stopping && Date.now() < stopAt) {
          const sub = `soak-${id}-${keepalives}`;
          const t0 = performance.now();
          ws.send(JSON.stringify(['REQ', sub, { kinds: [1], limit: 1 }]));
          for (;;) { // keepalive = one REQ answered by EOSE
            const msg = JSON.parse(await ws.recv(15000));
            if (msg[0] === 'EOSE' && msg[1] === sub) break;
            if (msg[0] === 'CLOSED' && msg[1] === sub) throw new Error(`CLOSED ${msg[2] || ''}`);
          }
          stats.reqLat.push(performance.now() - t0);
          keepalives++;
          await sleep(10000);
        }
      } catch (e) {
        deadAt = performance.now();
        stats.disconnects++;
        log(`conn ${id} disconnect ${e.message}`);
      }
      try { ws.close(); } catch {}
      if (stopping || Date.now() >= stopAt) break;
      // reconnect loop with backoff; measure time from disconnect to authed
      let attempt = 0;
      for (;;) {
        if (stopping) return;
        attempt++;
        try {
          const ws2 = await wsAuthed(TENANT_1, sk);
          const dt = performance.now() - deadAt;
          stats.reconOk++; stats.reconTimes.push(dt);
          log(`conn ${id} reconnect ok attempt=${attempt} ms=${dt.toFixed(0)}`);
          ws = ws2;
          break;
        } catch (e) {
          log(`conn ${id} reconnect FAIL attempt=${attempt} ${e.message}`);
          await sleep(Math.min(1000 * attempt, 10000));
          if (attempt >= 5) { stats.reconFail++; break; }
        }
      }
    }
    log(`conn ${id} loop end keepalives=${keepalives}`);
  }

  const stopAt = Date.now() + durationSecs * 1000;
  const loops = Array.from({ length: 50 }, (_, i) => connLoop(i));
  await new Promise((r) => { process.on('SIGINT', () => { stopping = true; log('SIGINT received — draining'); r(); }); });
  if (!stopping) await Promise.allSettled(loops);
  stopping = true;
  await Promise.race([Promise.allSettled(loops), sleep(5000)]);

  const rt = stats.reconTimes, total = stats.reconOk + stats.reconFail;
  const rl = pstats(stats.reqLat);
  log(`SUMMARY disconnects=${stats.disconnects} reconnect_success=${total ? ((stats.reconOk / total) * 100).toFixed(1) : 'n/a'}% ` +
    `reconnect_ms min=${rt.length ? Math.min(...rt).toFixed(0) : 'n/a'} max=${rt.length ? Math.max(...rt).toFixed(0) : 'n/a'} ` +
    `avg=${rt.length ? (rt.reduce((a, b) => a + b, 0) / rt.length).toFixed(0) : 'n/a'} req_p50=${fmt(rl.p50)} req_p95=${fmt(rl.p95)}`);
  result('soak', 'completed', true, `disconnects=${stats.disconnects} recon=${stats.reconOk}/${total}`);
}

// ---------- help + dispatch ----------

const HELP = `verify.mjs — Buzz relay Cloudflare spike verification (relay-v0.2.0)

Usage:
  doppler run --project ecombrain --config stg_teams -- node verify.mjs <subcommand>

Subcommands:
  provision              NIP-98 operator create of SPIKE_TENANT_HOST (idempotent, 2x),
                         then fail-closed check with an unprovisioned tenant Host.
  roundtrip [n=50]       WS A REQ + WS B EVENT through SPIKE_BASE (NIP-42 auth);
                         A must receive within 2s. Prints p50/p95 + failures.
  media                  Blossom PUT /media/upload 1MB, GET sha256 compare,
                         cross-tenant 404 (SPIKE_TENANT_HOST_2), 20MB upload.
  bench                  100x local finalizeEvent sign latency + 100x HTTP
                         roundtrips to SPIKE_BASE${STATUS_PATH}; PASS if p95 sum < 300ms.
  soak [--duration N]    50 concurrent WS conns, 1-line REQ keepalive every 10s,
                         N seconds (default 7200). Logs to soak-<unixts>.log.
                         SIGINT for graceful shutdown + summary.

Env: SPIKE_BASE, OPERATOR_NSEC (hex|nsec), RELAY_OPERATOR_API_ORIGIN,
     SPIKE_TENANT_HOST, SPIKE_TENANT_HOST_2, SPIKE_STATUS_PATH.
Output: RESULT <sub> <check> PASS|FAIL k=v... ; exit non-zero on any FAIL.`;

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP); process.exit(cmd ? 0 : 2); }
  const known = ['provision', 'roundtrip', 'media', 'bench', 'soak'];
  if (!known.includes(cmd)) { console.error(`unknown subcommand: ${cmd}\n\n${HELP}`); process.exit(2); }
  const rest = process.argv.slice(3);
  const flagVal = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : dflt;
  };
  const sk = loadOperatorKey();
  try {
    switch (cmd) {
      case 'provision': await cmdProvision(sk); break;
      case 'roundtrip': await cmdRoundtrip(sk, parseInt(rest[0] || '50', 10) || 50); break;
      case 'media': await cmdMedia(sk); break;
      case 'bench': await cmdBench(sk); break;
      case 'soak': await cmdSoak(sk, parseInt(flagVal('--duration', rest[0] || '7200'), 10) || 7200); break;
    }
  } catch (e) {
    result(cmd, 'fatal', false, e.message);
  }
  process.exit(failures ? 1 : 0);
}

main();
