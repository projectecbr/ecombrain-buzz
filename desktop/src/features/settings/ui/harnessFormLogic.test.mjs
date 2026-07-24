import assert from "node:assert/strict";
import test from "node:test";

import { idFromLabel, buildEnvRecord, filterArgs } from "./harnessFormLogic.ts";

// ── idFromLabel ──────────────────────────────────────────────────────────────

test("idFromLabel_typicalName_producesHyphenated", () => {
  assert.equal(idFromLabel("My Runtime"), "my-runtime");
});

test("idFromLabel_alreadyLowercase_returnsUnchanged", () => {
  assert.equal(idFromLabel("cursor"), "cursor");
});

test("idFromLabel_specialChars_replacedWithHyphens", () => {
  assert.equal(idFromLabel("Foo Bar!Baz"), "foo-bar-baz");
});

test("idFromLabel_consecutiveSpecialChars_collapsedToOneHyphen", () => {
  assert.equal(idFromLabel("foo   bar"), "foo-bar");
});

test("idFromLabel_trailingSpecialChars_stripped", () => {
  assert.equal(idFromLabel("my-runtime--"), "my-runtime");
});

test("idFromLabel_leadingHyphen_stripped", () => {
  // A label starting with a non-[a-z0-9_] char produces a leading hyphen;
  // the regex strips it so the id stays valid.
  assert.equal(idFromLabel("-bad"), "bad");
});

test("idFromLabel_underscorePreserved", () => {
  assert.equal(idFromLabel("my_agent"), "my_agent");
});

test("idFromLabel_emptyString_returnsEmpty", () => {
  assert.equal(idFromLabel(""), "");
});

test("idFromLabel_uppercaseOnly_lowercased", () => {
  assert.equal(idFromLabel("CURSOR"), "cursor");
});

// ── buildEnvRecord ───────────────────────────────────────────────────────────

test("buildEnvRecord_twoValidPairs_returnsBothEntries", () => {
  assert.deepEqual(
    buildEnvRecord([
      { key: "FOO", value: "bar" },
      { key: "BAZ", value: "qux" },
    ]),
    { FOO: "bar", BAZ: "qux" },
  );
});

test("buildEnvRecord_emptyKey_skipped", () => {
  assert.deepEqual(
    buildEnvRecord([
      { key: "", value: "orphaned-value" },
      { key: "KEEP", value: "yes" },
    ]),
    { KEEP: "yes" },
  );
});

test("buildEnvRecord_whitespaceOnlyKey_skipped", () => {
  assert.deepEqual(buildEnvRecord([{ key: "   ", value: "x" }]), {});
});

test("buildEnvRecord_keyWithLeadingTrailingSpaces_trimmed", () => {
  // Key is trimmed; value is preserved verbatim.
  assert.deepEqual(buildEnvRecord([{ key: "  MY_VAR  ", value: " val " }]), {
    MY_VAR: " val ",
  });
});

test("buildEnvRecord_emptyPairs_returnsEmptyObject", () => {
  assert.deepEqual(buildEnvRecord([]), {});
});

test("buildEnvRecord_duplicateKeys_lastValueWins", () => {
  assert.deepEqual(
    buildEnvRecord([
      { key: "X", value: "first" },
      { key: "X", value: "second" },
    ]),
    { X: "second" },
  );
});

// ── filterArgs ───────────────────────────────────────────────────────────────

test("filterArgs_normalArgs_allPreserved", () => {
  assert.deepEqual(filterArgs(["--flag", "--output", "file.txt"]), [
    "--flag",
    "--output",
    "file.txt",
  ]);
});

test("filterArgs_emptyString_removed", () => {
  assert.deepEqual(filterArgs([""]), []);
});

test("filterArgs_whitespaceOnlyArg_removed", () => {
  assert.deepEqual(filterArgs(["  "]), []);
});

test("filterArgs_mixedEmptyAndReal_onlyRealKept", () => {
  assert.deepEqual(filterArgs(["acp", "", "--verbose", "   "]), [
    "acp",
    "--verbose",
  ]);
});

test("filterArgs_argWithInternalSpaces_preserved", () => {
  // An arg with leading/trailing spaces but non-whitespace content is kept
  // (trim only tests emptiness, not the full value).
  assert.deepEqual(filterArgs(["--name", "hello world"]), [
    "--name",
    "hello world",
  ]);
});

test("filterArgs_emptyArray_returnsEmpty", () => {
  assert.deepEqual(filterArgs([]), []);
});
