// Contract test — Adapter A (browser WebSocket transport).
//
// Imports the real desktop platform adapter
// (desktop/src/platform/transport.browser.ts) and drives it against the local
// staging-backed Buzz relay at ws://localhost:3335, exactly the way
// relayClientSession will:
//   connect → NIP-42 AUTH (kind:22242, relay tag = tenant ws URL) →
//   REQ kind 1 (EOSE) → EVENT kind 1 (OK + delivery) → close → reconnect.
//
// The adapter accepts an injectable WebSocket constructor; node passes the
// `ws` package, the web bundle defaults to globalThis.WebSocket.
//
// Run: npm test   (from ecombrain/contract-tests; relay must be up —
// `docker start buzz-relay-staging`, ~20s boot)

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { WebSocket } from "ws";

import { createBrowserTransport } from "../../desktop/src/platform/transport.browser.ts";

const RELAY_URL = "ws://localhost:3335";
// NIP-42 relay tag must carry the TENANT host; the local relay is seeded
// with tenant host localhost:3335.
const RELAY_TAG = "ws://localhost:3335";

const sk = generateSecretKey();
const nowSecs = () => Math.floor(Date.now() / 1000);

/** Async frame queue: onMessage pushes, tests await frames in order. */
function frameQueue() {
  const queue = [];
  const waiters = [];
  return {
    push(frame) {
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        queue.push(frame);
      }
    },
    next(timeoutMs = 8000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`timed out waiting for relay frame (${timeoutMs}ms)`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

/** Next TEXT frame (control frames like {type:"Close"} are skipped). */
async function nextText(frames, timeoutMs) {
  for (;;) {
    const frame = await frames.next(timeoutMs);
    if (typeof frame === "string") return JSON.parse(frame);
  }
}

/** Connect and complete the NIP-42 handshake. Returns { handle, frames }. */
async function authedConnect(transport) {
  const frames = frameQueue();
  const handle = await transport.connect(RELAY_URL, (_handle, message) => {
    frames.push(message);
  });
  assert.equal(typeof handle.id, "number", "connect must resolve with {id}");

  const hello = await nextText(frames, 5000);
  assert.equal(hello[0], "AUTH", "relay must send the NIP-42 challenge first");

  const authEvent = finalizeEvent(
    {
      kind: 22242,
      created_at: nowSecs(),
      tags: [
        ["relay", RELAY_TAG],
        ["challenge", hello[1]],
      ],
      content: "",
    },
    sk,
  );
  transport.send(handle, JSON.stringify(["AUTH", authEvent]));

  for (;;) {
    const msg = await nextText(frames, 5000);
    if (msg[0] === "OK" && msg[1] === authEvent.id) {
      assert.equal(msg[2], true, `NIP-42 auth rejected: ${msg[3] ?? ""}`);
      break;
    }
  }
  return { handle, frames };
}

test("browser transport: NIP-42 + REQ/EVENT/EOSE/OK + close + reconnect", async () => {
  const transport = createBrowserTransport({ WebSocketImpl: WebSocket });

  // Subscriber connection (mirrors verify.mjs roundtrip: REQ on A, EVENT on B).
  const sub = await authedConnect(transport);
  const pub = await authedConnect(transport);

  transport.send(
    sub.handle,
    JSON.stringify(["REQ", "contract-sub", { kinds: [1], limit: 5 }]),
  );

  const event = finalizeEvent(
    {
      kind: 1,
      created_at: nowSecs(),
      tags: [],
      content: `contract-test ${randomUUID()}`,
    },
    sk,
  );
  transport.send(pub.handle, JSON.stringify(["EVENT", event]));

  let eose = false;
  let published = false;
  let delivered = false;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(eose && published && delivered)) {
    const left = deadline - Date.now();
    const [subMsg, pubMsg] = await Promise.allSettled([
      eose && delivered ? null : nextText(sub.frames, left),
      published ? null : nextText(pub.frames, left),
    ]);
    const subValue = subMsg.status === "fulfilled" ? subMsg.value : null;
    const pubValue = pubMsg.status === "fulfilled" ? pubMsg.value : null;
    if (subValue) {
      if (subValue[0] === "EOSE" && subValue[1] === "contract-sub") eose = true;
      if (
        subValue[0] === "EVENT" &&
        subValue[1] === "contract-sub" &&
        subValue[2]?.id === event.id
      ) {
        delivered = true;
      }
    }
    if (pubValue && pubValue[0] === "OK" && pubValue[1] === event.id) {
      assert.equal(pubValue[2], true, `EVENT rejected: ${pubValue[3] ?? ""}`);
      published = true;
    }
    if (!subValue && !pubValue) break; // both timed out
  }

  assert.ok(eose, "EOSE received for REQ");
  assert.ok(published, "OK received for published EVENT");
  assert.ok(delivered, "published EVENT delivered to the subscription");

  // Close both, then prove the adapter supports a fresh connect cycle.
  transport.close(sub.handle);
  transport.close(pub.handle);

  const again = await authedConnect(transport);
  transport.close(again.handle);
});
