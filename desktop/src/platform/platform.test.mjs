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

test("getTransport_returnsLazyAdapterWithoutLoadingImpl", () => {
  // Wired in Task 2: returns a lazy proxy synchronously; the real adapter
  // (tauri or browser) loads on first connect() via dynamic import.
  const transport = getTransport();
  assert.equal(typeof transport.connect, "function");
  assert.equal(typeof transport.send, "function");
  assert.equal(typeof transport.close, "function");
});

test("getSigner_returnsLazyAdapterWithoutLoadingImpl", () => {
  // Wired in Task 3: returns a lazy proxy synchronously; the real adapter
  // (tauri sign_event or localkey dev signer) loads on first use via dynamic
  // import.
  const signer = getSigner();
  assert.equal(typeof signer.getPublicKey, "function");
  assert.equal(typeof signer.signEvent, "function");
});

test("getCommands_returnsLazyAdapterWithoutLoadingImpl", () => {
  // Wired in Task 4: returns a lazy proxy synchronously; the real adapter
  // (tauri invoke passthrough or NIP-98 REST) loads on first call() via
  // dynamic import.
  const commands = getCommands();
  assert.equal(typeof commands.call, "function");
});

test("platformFactories_mediaStillThrowsNotWiredYet", () => {
  const factories = { getMedia };
  for (const [name, factory] of Object.entries(factories)) {
    assert.equal(typeof factory, "function", `${name} must be exported`);
    assert.throws(() => factory(), /not wired yet/, `${name} must throw`);
  }
});
