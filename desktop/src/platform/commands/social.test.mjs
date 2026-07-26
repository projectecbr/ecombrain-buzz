import assert from "node:assert/strict";
import test from "node:test";

import { socialHandlers } from "./social.ts";

test("contact writes stay within the custody tag limit", async () => {
  const handlers = socialHandlers({});
  const contacts = Array.from({ length: 101 }, (_, index) => ({
    pubkey: index.toString(16).padStart(64, "0"),
  }));

  await assert.rejects(
    handlers.set_contact_list({ contacts }),
    /too many contacts \(max 100, got 101\)/,
  );
});
