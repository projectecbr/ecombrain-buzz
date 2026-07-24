//! Loader for user-defined ACP harness definitions.
//!
//! Users drop JSON files into `<app-data>/custom_harnesses/` to register
//! arbitrary ACP-speaking agents without modifying the app or opening a PR.
//! Each file describes a single harness; the loader validates, warns on
//! invalid entries, and never propagates errors to the discovery caller.
//!
//! **Security constraint (Will-ratified):** custom definitions carry NO install
//! shell commands. `can_auto_install` is always `false` for custom entries.
//! Only tier-1 compiled-in runtimes retain install-script power.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// Regex-equivalent predicate for a valid harness ID.
///
/// IDs must match `[a-z0-9_][a-z0-9_-]*` — lowercase alphanumeric plus
/// hyphens and underscores, starting with an alphanumeric or underscore.
/// This mirrors goose's `generate_id` validation and is intentionally
/// more restrictive than the filesystem to prevent path-traversal tricks.
fn is_valid_harness_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Public re-export of `is_valid_harness_id` for callers outside this module
/// (e.g., the `delete_custom_harness` command that must validate caller-supplied ids).
pub(crate) fn is_valid_harness_id_pub(id: &str) -> bool {
    is_valid_harness_id(id)
}

/// User-supplied harness definition deserialized from a JSON file.
///
/// Only the fields a custom harness definition is permitted to carry are
/// included here — install commands are intentionally absent (security line).
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarnessDefinition {
    /// Unique identifier, must match `[a-z0-9_][a-z0-9_-]*`.
    pub id: String,
    /// Human-readable name shown in the UI.
    pub label: String,
    /// Primary executable name or absolute path. May not be empty.
    pub command: String,
    /// Optional default CLI arguments passed to the command.
    #[serde(default)]
    pub args: Vec<String>,
    /// URL to an avatar image. Empty string → no avatar.
    #[serde(default)]
    pub avatar_url: String,
    /// Link to external docs for manual install/setup instructions.
    #[serde(default)]
    pub install_instructions_url: String,
    /// Human-readable install hint shown in Doctor.
    #[serde(default)]
    pub install_hint: String,
}

/// Scan `dir` for `*.json` files and deserialize each into a `HarnessDefinition`.
///
/// Errors per file are logged with `tracing::warn` and skipped — a single
/// malformed file never fails discovery for the rest.  Returns only
/// structurally valid, individually validated definitions.
///
/// **Callers must supply a fresh `dir` path on every `discover_acp_runtimes`
/// call** — this function performs no caching, mirroring goose's
/// `refresh_custom_providers()` pattern.
pub(crate) fn load_custom_harnesses(dir: &Path) -> Vec<HarnessDefinition> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return vec![],
        Err(err) => {
            eprintln!(
                "custom_harnesses: cannot read directory {}: {err}",
                dir.display()
            );
            return vec![];
        }
    };

    let mut definitions = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }

        let contents = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("custom_harnesses: failed to read {}: {err}", path.display());
                continue;
            }
        };

        let def: HarnessDefinition = match serde_json::from_str(&contents) {
            Ok(d) => d,
            Err(err) => {
                eprintln!(
                    "custom_harnesses: invalid JSON in {}: {err}",
                    path.display()
                );
                continue;
            }
        };

        if let Err(reason) = validate_harness_definition(&def) {
            eprintln!("custom_harnesses: skipping {} — {reason}", path.display());
            continue;
        }

        definitions.push(def);
    }

    definitions
}

/// Validate a deserialized `HarnessDefinition` against the invariants that
/// the rest of the discovery code depends on.
fn validate_harness_definition(def: &HarnessDefinition) -> Result<(), String> {
    if def.id.is_empty() {
        return Err("id must not be empty".into());
    }
    if !is_valid_harness_id(&def.id) {
        return Err(format!(
            "id {:?} does not match [a-z0-9_][a-z0-9_-]* — use lowercase letters, digits, hyphens, and underscores only",
            def.id
        ));
    }
    if def.command.trim().is_empty() {
        return Err("command must not be empty".into());
    }
    if def.label.trim().is_empty() {
        return Err("label must not be empty".into());
    }
    Ok(())
}

/// Public wrapper so the `save_custom_harness` Tauri command can validate
/// without duplicating the rules.
pub(crate) fn validate_harness_definition_pub(def: &HarnessDefinition) -> Result<(), String> {
    validate_harness_definition(def)
}

// ── Built-in ID set ──────────────────────────────────────────────────────────

/// IDs reserved for the compiled-in catalog. A custom definition whose `id`
/// collides with a built-in is rejected to prevent shadowing (e.g. a file
/// called `goose.json` overriding the first-class Goose runtime).
const BUILTIN_IDS: &[&str] = &["goose", "claude", "codex", "buzz-agent"];

/// Return an error string if `id` conflicts with a built-in harness ID.
pub(crate) fn check_id_collision(id: &str) -> Result<(), String> {
    if BUILTIN_IDS.contains(&id) {
        return Err(format!(
            "id {:?} is reserved for a built-in harness and cannot be overridden",
            id
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // ── ID validation ────────────────────────────────────────────────────────

    #[test]
    fn valid_id_lowercase_with_hyphen() {
        assert!(is_valid_harness_id("my-agent"));
    }

    #[test]
    fn valid_id_underscore_start() {
        assert!(is_valid_harness_id("_my_agent"));
    }

    #[test]
    fn valid_id_alphanumeric() {
        assert!(is_valid_harness_id("agent42"));
    }

    #[test]
    fn invalid_id_uppercase() {
        assert!(!is_valid_harness_id("MyAgent"));
    }

    #[test]
    fn invalid_id_starts_with_hyphen() {
        assert!(!is_valid_harness_id("-bad-id"));
    }

    #[test]
    fn invalid_id_empty() {
        assert!(!is_valid_harness_id(""));
    }

    #[test]
    fn invalid_id_path_traversal() {
        assert!(!is_valid_harness_id("../etc/passwd"));
    }

    // ── Collision check ──────────────────────────────────────────────────────

    #[test]
    fn builtin_ids_are_rejected() {
        for id in BUILTIN_IDS {
            assert!(check_id_collision(id).is_err(), "{id} should be rejected");
        }
    }

    #[test]
    fn unknown_id_passes_collision_check() {
        assert!(check_id_collision("my-custom-agent").is_ok());
    }

    // ── File loading ─────────────────────────────────────────────────────────

    #[test]
    fn load_valid_json_returns_definition() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("my-agent.json"),
            r#"{"id":"my-agent","label":"My Agent","command":"my-agent-bin"}"#,
        )
        .unwrap();

        let defs = load_custom_harnesses(dir.path());
        assert_eq!(defs.len(), 1);
        assert_eq!(defs[0].id, "my-agent");
        assert_eq!(defs[0].label, "My Agent");
        assert_eq!(defs[0].command, "my-agent-bin");
    }

    #[test]
    fn load_skips_non_json_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("my-agent.toml"), r#"id = "my-agent""#).unwrap();

        let defs = load_custom_harnesses(dir.path());
        assert_eq!(defs.len(), 0, "non-JSON file should be ignored");
    }

    #[test]
    fn load_skips_invalid_json_without_panicking() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("bad.json"), "{ not valid json").unwrap();

        // Must not panic or propagate an error.
        let defs = load_custom_harnesses(dir.path());
        assert_eq!(defs.len(), 0);
    }

    #[test]
    fn load_skips_definition_with_invalid_id() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("Bad.json"),
            r#"{"id":"Bad-Id","label":"Bad","command":"bad"}"#,
        )
        .unwrap();

        let defs = load_custom_harnesses(dir.path());
        assert_eq!(
            defs.len(),
            0,
            "invalid id should cause the entry to be skipped"
        );
    }

    #[test]
    fn load_skips_definition_with_empty_command() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("empty-cmd.json"),
            r#"{"id":"empty-cmd","label":"Empty","command":""}"#,
        )
        .unwrap();

        let defs = load_custom_harnesses(dir.path());
        assert_eq!(
            defs.len(),
            0,
            "empty command should cause the entry to be skipped"
        );
    }

    #[test]
    fn load_missing_dir_returns_empty_vec() {
        let dir = tempfile::tempdir().unwrap();
        let nonexistent = dir.path().join("does_not_exist");

        let defs = load_custom_harnesses(&nonexistent);
        assert_eq!(defs.len(), 0);
    }

    #[test]
    fn load_continues_after_one_bad_entry() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("bad.json"), "!!!").unwrap();
        fs::write(
            dir.path().join("good.json"),
            r#"{"id":"good-one","label":"Good","command":"good-binary"}"#,
        )
        .unwrap();

        let defs = load_custom_harnesses(dir.path());
        assert_eq!(defs.len(), 1, "bad entry skipped, good entry loaded");
        assert_eq!(defs[0].id, "good-one");
    }

    #[test]
    fn load_applies_id_collision_check() {
        // A custom file named "goose.json" with id "goose" must be rejected.
        // The collision check is applied inside discover_acp_runtimes_from, not
        // in load_custom_harnesses — the file loader only validates the struct.
        // We test the check_id_collision fn directly here.
        assert!(check_id_collision("goose").is_err());
        assert!(check_id_collision("custom-goose").is_ok());
    }

    // ── Round-trip: save → load → delete → load ──────────────────────────────

    #[test]
    fn round_trip_save_then_load_then_delete() {
        let dir = tempfile::tempdir().unwrap();
        let def = HarnessDefinition {
            id: "my-rt".to_string(),
            label: "My Runtime".to_string(),
            command: "my-rt-bin".to_string(),
            args: vec!["--flag".to_string()],
            avatar_url: String::new(),
            install_instructions_url: "https://example.com".to_string(),
            install_hint: "Install from example.com".to_string(),
        };

        // Serialize and write (simulating save_custom_harness logic).
        let json = serde_json::to_string_pretty(&def).unwrap();
        let target = dir.path().join(format!("{}.json", def.id));
        fs::write(&target, &json).unwrap();

        // Load should return exactly one entry.
        let loaded = load_custom_harnesses(dir.path());
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "my-rt");
        assert_eq!(loaded[0].command, "my-rt-bin");
        assert_eq!(loaded[0].args, vec!["--flag"]);

        // Delete the file (simulating delete_custom_harness).
        fs::remove_file(&target).unwrap();

        // Load should now return an empty list.
        let after_delete = load_custom_harnesses(dir.path());
        assert!(
            after_delete.is_empty(),
            "directory should be empty after delete"
        );
    }

    #[test]
    fn round_trip_overwrite_existing_definition() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rt.json");

        // Write v1.
        fs::write(&path, r#"{"id":"rt","label":"V1","command":"rt-bin"}"#).unwrap();

        let v1 = load_custom_harnesses(dir.path());
        assert_eq!(v1[0].label, "V1");

        // Overwrite with v2 (simulates save on an existing definition).
        fs::write(&path, r#"{"id":"rt","label":"V2","command":"rt-bin-v2"}"#).unwrap();

        let v2 = load_custom_harnesses(dir.path());
        assert_eq!(v2.len(), 1, "overwrite must not duplicate entries");
        assert_eq!(v2[0].label, "V2");
        assert_eq!(v2[0].command, "rt-bin-v2");
    }
}
