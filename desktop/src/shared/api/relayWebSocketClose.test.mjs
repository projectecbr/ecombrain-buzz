import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTauriTransport } from "../../platform/transport.tauri.ts";

// The close/send wire shapes moved behind the transport seam in Phase 2
// Task 2 (closeWebSocket now delegates to getTransport().close); these tests
// pin the exact plugin:websocket frames the Tauri adapter must produce.

test("transport.close sends a Close frame through plugin:websocket|send", async () => {
  const calls = [];
  const transport = createTauriTransport({
    invokeFn: async (cmd, args) => {
      calls.push({ cmd, args });
    },
  });

  transport.close({ id: 42 }, "workspace switch");
  // close() is fire-and-forget; let the invoke promise settle.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "plugin:websocket|send");
  assert.deepEqual(calls[0].args, {
    id: 42,
    message: {
      type: "Close",
      data: { code: 1000, reason: "workspace switch" },
    },
  });
});

test("transport.close swallows send failures (socket already gone)", async () => {
  const transport = createTauriTransport({
    invokeFn: async () => {
      throw new Error("WebSocket connection not found");
    },
  });
  transport.close({ id: 7 }, "connection reset");
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("transport.send sends a Text frame through plugin:websocket|send", async () => {
  const calls = [];
  const transport = createTauriTransport({
    invokeFn: async (cmd, args) => {
      calls.push({ cmd, args });
    },
  });

  await transport.send({ id: 9 }, '["REQ","s",{}]');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "plugin:websocket|send");
  assert.deepEqual(calls[0].args, {
    id: 9,
    message: { type: "Text", data: '["REQ","s",{}]' },
  });
});

// Regression guard: tauri-plugin-websocket registers only `connect` and
// `send` — there is no `disconnect` command. Invoking one rejects silently
// and leaks the socket (relay zombie pile, workspace-switch disconnects).
// Any socket teardown must go through the transport's Close frame.
test("no source file invokes the nonexistent plugin:websocket|disconnect command", () => {
  const srcRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const offenders = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) continue;
      if (full === fileURLToPath(import.meta.url)) continue;
      if (
        fs.readFileSync(full, "utf8").includes("plugin:websocket|disconnect")
      ) {
        offenders.push(path.relative(srcRoot, full));
      }
    }
  };
  walk(srcRoot);

  assert.deepEqual(
    offenders,
    [],
    "plugin:websocket|disconnect does not exist in tauri-plugin-websocket — use the transport close (Close frame via plugin:websocket|send) instead",
  );
});
