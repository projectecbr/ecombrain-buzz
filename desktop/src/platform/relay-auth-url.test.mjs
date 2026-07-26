import assert from "node:assert/strict";
import test from "node:test";

import {
  clearRelayBinding,
  relayAuthHttpUrl,
  relayAuthWsUrl,
  saveRelayBinding,
} from "./relay-auth-url.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test("relay auth signs the canonical tenant URL while transport stays public", () => {
  const storage = memoryStorage();
  saveRelayBinding(
    {
      transportUrl: "wss://app.ecombrain.io/teams/relay",
      authUrl:
        "wss://tenant-11111111-1111-4111-8111-111111111111.teams.ecombrain.internal",
      expiresAt: Date.now() + 60_000,
    },
    storage,
  );

  assert.equal(
    relayAuthWsUrl("wss://app.ecombrain.io/teams/relay", storage),
    "wss://tenant-11111111-1111-4111-8111-111111111111.teams.ecombrain.internal",
  );
  assert.equal(
    relayAuthHttpUrl(
      "https://app.ecombrain.io/teams/relay/query?limit=10",
      storage,
    ),
    "https://tenant-11111111-1111-4111-8111-111111111111.teams.ecombrain.internal/query?limit=10",
  );

  clearRelayBinding(storage);
  assert.equal(
    relayAuthWsUrl("wss://app.ecombrain.io/teams/relay", storage),
    "wss://app.ecombrain.io/teams/relay",
  );
});
