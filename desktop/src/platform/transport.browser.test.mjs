import assert from "node:assert/strict";
import test from "node:test";

import { createBrowserTransport } from "./transport.browser.ts";

class FakeWebSocket {
  static instance;

  listeners = new Map();
  closeCalls = 0;

  constructor() {
    FakeWebSocket.instance = this;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  emit(type, event = {}) {
    this.listeners.get(type)?.(event);
  }

  send() {}

  close() {
    this.closeCalls += 1;
  }
}

test("pre-open error followed by close emits no phantom handle event", async () => {
  const received = [];
  const transport = createBrowserTransport({
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 100,
  });
  const connection = transport.connect("wss://relay.invalid", (...args) => {
    received.push(args);
  });

  FakeWebSocket.instance.emit("error");
  FakeWebSocket.instance.emit("close", { code: 1006, reason: "failed" });

  await assert.rejects(connection, /connection .* failed/);
  assert.deepEqual(received, []);
});

test("connect rejects and closes a socket that never opens", async () => {
  const transport = createBrowserTransport({
    WebSocketImpl: FakeWebSocket,
    connectTimeoutMs: 5,
  });

  await assert.rejects(
    transport.connect("wss://relay.invalid", () => {}),
    /connection .* timed out/,
  );
  assert.equal(FakeWebSocket.instance.closeCalls, 1);
});
