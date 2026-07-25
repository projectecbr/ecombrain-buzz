import assert from "node:assert/strict";
import test from "node:test";

import {
  __setPlatformOverrideForTests,
  getCommands,
  getMedia,
  getPlatform,
  getSigner,
  getTransport,
} from "./index.ts";

test("getPlatform_defaultsToTauriOutsideWebBuild", () => {
  // In the node test runner `import.meta.env` is undefined — the same shape
  // as a desktop/Tauri build where VITE_PLATFORM is never defined.
  __setPlatformOverrideForTests(null);
  assert.equal(getPlatform(), "tauri");
});

test("getPlatform_returnsWebWhenVitePlatformIsWeb", () => {
  // The web build defines `import.meta.env.VITE_PLATFORM === "web"`; the
  // override seam simulates that define outside the Vite pipeline.
  __setPlatformOverrideForTests("web");
  try {
    assert.equal(getPlatform(), "web");
  } finally {
    __setPlatformOverrideForTests(null);
  }
});

test("platformFactories_existAndThrowNotWiredYet", () => {
  const factories = { getTransport, getSigner, getCommands, getMedia };
  for (const [name, factory] of Object.entries(factories)) {
    assert.equal(typeof factory, "function", `${name} must be exported`);
    assert.throws(() => factory(), /not wired yet/, `${name} must throw`);
  }
});
