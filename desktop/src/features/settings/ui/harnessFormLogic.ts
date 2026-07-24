/**
 * Pure logic helpers for the custom-harness form.
 *
 * Extracted so they can be tested independently from the React layer.
 */

/**
 * Derive a valid harness ID from a human-readable display name.
 *
 * Rules match the backend `is_valid_harness_id` predicate:
 *   [a-z0-9_][a-z0-9_-]*
 *
 * The transform:
 *   1. Lowercase the label.
 *   2. Replace any character outside [a-z0-9_-] with a hyphen.
 *   3. Strip a leading character that isn't [a-z0-9_] (covers e.g. "-foo").
 *   4. Collapse runs of hyphens.
 *   5. Strip trailing hyphens.
 */
export function idFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9_]/, "")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
}

/**
 * Build the env-variable record that goes into the save payload.
 *
 * Pairs with empty keys are silently skipped — they represent blank
 * rows the user hasn't filled in yet.
 */
export function buildEnvRecord(
  pairs: ReadonlyArray<{ key: string; value: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}

/**
 * Remove empty/whitespace-only argument rows from the args list before
 * sending to the backend.  Preserves legitimate blank-string args only
 * when they contain non-whitespace content so quoted/complex args are
 * never silently dropped.
 */
export function filterArgs(args: ReadonlyArray<string>): string[] {
  return args.filter((a) => a.trim() !== "");
}
