import assert from "node:assert/strict";
import test from "node:test";

import { createTauriTransport } from "../../platform/transport.tauri.ts";
import { closeAllWebSockets } from "./relayWebSocketClose.ts";

test("transport.close invokes the owned native disconnect", async () => {
  const calls = [];
  const transport = createTauriTransport({
    invokeFn: async (cmd, args) => {
      calls.push({ cmd, args });
    },
  });

  transport.close({ id: 42 }, "community switch");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(calls, [
    { cmd: "plugin:websocket|disconnect", args: { id: 42 } },
  ]);
});

test("transport.close is idempotent when the native socket is gone", async () => {
  const transport = createTauriTransport({
    invokeFn: async () => {
      throw new Error("WebSocket connection not found");
    },
  });
  transport.close({ id: 7 }, "connection reset");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("transport.send sends a Text frame through the native socket", async () => {
  const calls = [];
  const transport = createTauriTransport({
    invokeFn: async (cmd, args) => {
      calls.push({ cmd, args });
    },
  });

  await transport.send({ id: 9 }, '["REQ","s",{}]');

  assert.deepEqual(calls, [
    {
      cmd: "plugin:websocket|send",
      args: {
        id: 9,
        message: { type: "Text", data: '["REQ","s",{}]' },
      },
    },
  ]);
});

test("closeAllWebSockets invokes native process-wide teardown", async () => {
  const calls = [];
  await closeAllWebSockets(async (cmd, args) => calls.push({ cmd, args }));
  assert.deepEqual(calls, [
    { cmd: "plugin:websocket|disconnect_all", args: undefined },
  ]);
});
