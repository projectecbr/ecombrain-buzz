import * as React from "react";
import { ExternalLink, Plus, Terminal, Trash2, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  useAcpRuntimesQuery,
  useDeleteCustomHarnessMutation,
  useManagedAgentPrereqsQuery,
  useSaveCustomHarnessMutation,
} from "@/features/agents/hooks";
import type { AcpRuntimeCatalogEntry } from "@/shared/api/types";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Spinner } from "@/shared/ui/spinner";

import { SettingsSectionHeader } from "./SettingsSectionHeader";

// ── Preset definitions ────────────────────────────────────────────────────────
//
// These seed the gallery. command/args/installInstructionsUrl verified against
// vendor docs and held PRs (#2536 cursor, #2573 omp, #2546 grok, #2370 opencode,
// #2365 kimi). amp-acp verified from https://github.com/tao12345666333/amp-acp.

interface HarnessPreset {
  id: string;
  label: string;
  command: string;
  args: string[];
  installInstructionsUrl: string;
  logoPath: string;
}

const HARNESS_PRESETS: HarnessPreset[] = [
  {
    id: "cursor",
    label: "Cursor",
    command: "cursor-agent",
    args: ["acp"],
    installInstructionsUrl: "https://cursor.com/downloads",
    logoPath: "/harness-logos/cursor.png",
  },
  {
    id: "omp",
    label: "Oh My Pi",
    command: "omp",
    args: ["acp"],
    installInstructionsUrl: "https://ohmyposh.dev/docs/installation/linux",
    logoPath: "/harness-logos/omp.png",
  },
  {
    id: "grok",
    label: "Grok Build",
    command: "grok",
    args: ["agent", "--always-approve", "stdio"],
    installInstructionsUrl: "https://build.x.ai/docs",
    logoPath: "/harness-logos/grok.png",
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    args: ["acp"],
    installInstructionsUrl: "https://opencode.ai/docs",
    logoPath: "/harness-logos/opencode.svg",
  },
  {
    id: "kimi",
    label: "Kimi Code",
    command: "kimi",
    args: ["acp"],
    installInstructionsUrl: "https://kimi.ai/download",
    logoPath: "/harness-logos/kimi.png",
  },
  {
    id: "amp",
    label: "Amp",
    command: "amp-acp",
    args: [],
    installInstructionsUrl: "https://github.com/tao12345666333/amp-acp",
    logoPath: "/harness-logos/amp.png",
  },
];

// ── Logo component ────────────────────────────────────────────────────────────

function PresetLogo({ logoPath, label }: { logoPath: string; label: string }) {
  const [errored, setErrored] = React.useState(false);
  if (errored) {
    return (
      <Terminal aria-hidden="true" className="h-6 w-6 text-muted-foreground" />
    );
  }
  return (
    <img
      alt={label}
      className="h-8 w-8 rounded-lg object-contain"
      onError={() => setErrored(true)}
      src={logoPath}
    />
  );
}

// ── Preset card ───────────────────────────────────────────────────────────────

function PresetCard({
  catalog,
  preset,
  onAdd,
}: {
  catalog: AcpRuntimeCatalogEntry[];
  preset: HarnessPreset;
  onAdd: (preset: HarnessPreset) => void;
}) {
  // Check if this preset is already in the catalog (builtin or custom).
  const existing = catalog.find((e) => e.id === preset.id);
  const isDetected = existing?.availability === "available";
  const isAlreadySaved = existing?.source === "custom";
  const isBuiltin = existing?.source === "builtin";

  return (
    <div
      className={cn(
        "relative flex flex-col gap-3 rounded-2xl border px-4 py-4 text-sm transition-colors",
        isDetected
          ? "border-emerald-500/20 bg-emerald-500/5"
          : "border-border/60 bg-muted/20",
      )}
      data-testid={`harness-preset-${preset.id}`}
    >
      <div className="flex items-center gap-3">
        <PresetLogo label={preset.label} logoPath={preset.logoPath} />
        <div className="min-w-0 flex-1">
          <p className="font-medium leading-none">{preset.label}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {preset.command}
          </p>
        </div>
        {isDetected ? (
          <span className="inline-flex shrink-0 items-center rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            Detected
          </span>
        ) : null}
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2">
        {isBuiltin ? (
          <span className="text-xs text-muted-foreground">
            Built-in runtime
          </span>
        ) : isAlreadySaved ? (
          <span className="text-xs text-muted-foreground">
            Already added as custom harness
          </span>
        ) : (
          <Button
            className="h-7 px-3 text-xs"
            data-testid={`harness-preset-add-${preset.id}`}
            onClick={() => onAdd(preset)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        )}
        {!isDetected ? (
          <button
            className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => void openUrl(preset.installInstructionsUrl)}
            type="button"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            Install
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ── Custom harness form ───────────────────────────────────────────────────────

interface CustomFormValues {
  id: string;
  label: string;
  command: string;
  args: string;
  installInstructionsUrl: string;
  installHint: string;
}

const EMPTY_FORM: CustomFormValues = {
  id: "",
  label: "",
  command: "",
  args: "",
  installInstructionsUrl: "",
  installHint: "",
};

function idFromLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^[^a-z0-9_]/, "")
    .replace(/-{2,}/g, "-")
    .replace(/-+$/, "");
}

function CommandAvailabilityBadge({ command }: { command: string }) {
  const trimmed = command.trim();
  const prereqs = useManagedAgentPrereqsQuery(trimmed, "", {
    enabled: trimmed.length > 0,
  });

  if (!trimmed || prereqs.isLoading) return null;

  const available = prereqs.data?.acp.available;
  if (available === undefined) return null;

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        available
          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      )}
    >
      {available ? "Found on PATH" : "Not found on PATH"}
    </span>
  );
}

function CustomHarnessForm({
  initial,
  onCancel,
  onSaved,
}: {
  initial?: Partial<CustomFormValues>;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState<CustomFormValues>({
    ...EMPTY_FORM,
    ...initial,
  });
  const [error, setError] = React.useState<string | null>(null);
  const save = useSaveCustomHarnessMutation();

  function field(key: keyof CustomFormValues) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setForm((prev) => {
        const next = { ...prev, [key]: value };
        // Auto-derive id from label when id is empty or was auto-derived.
        if (
          key === "label" &&
          (!prev.id || prev.id === idFromLabel(prev.label))
        ) {
          next.id = idFromLabel(value);
        }
        return next;
      });
    };
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const argsArray = form.args
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      await save.mutateAsync({
        id: form.id.trim(),
        label: form.label.trim(),
        command: form.command.trim(),
        args: argsArray,
        avatarUrl: "",
        installInstructionsUrl: form.installInstructionsUrl.trim(),
        installHint: form.installHint.trim(),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form
      className="space-y-3 rounded-2xl border border-border/60 bg-muted/10 px-4 py-4"
      data-testid="custom-harness-form"
      onSubmit={(e) => void handleSubmit(e)}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Add custom harness</p>
        <button
          aria-label="Cancel"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onCancel}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">Name</p>
          <Input
            className="h-8 text-sm"
            id="ch-label"
            onChange={field("label")}
            placeholder="My Runtime"
            required
            value={form.label}
          />
        </div>
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            ID <span className="text-muted-foreground/60">(auto-derived)</span>
          </p>
          <Input
            className="h-8 font-mono text-sm"
            id="ch-id"
            onChange={field("id")}
            placeholder="my-runtime"
            required
            value={form.id}
          />
        </div>
      </div>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground">Command</p>
          <CommandAvailabilityBadge command={form.command} />
        </div>
        <Input
          className="h-8 font-mono text-sm"
          id="ch-command"
          onChange={field("command")}
          placeholder="my-agent-bin"
          required
          value={form.command}
        />
      </div>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Arguments{" "}
          <span className="text-muted-foreground/60">(space-separated)</span>
        </p>
        <Input
          className="h-8 font-mono text-sm"
          id="ch-args"
          onChange={field("args")}
          placeholder="acp"
          value={form.args}
        />
      </div>

      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          Docs URL <span className="text-muted-foreground/60">(optional)</span>
        </p>
        <Input
          className="h-8 text-sm"
          id="ch-docs-url"
          onChange={field("installInstructionsUrl")}
          placeholder="https://example.com/docs"
          value={form.installInstructionsUrl}
        />
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button onClick={onCancel} size="sm" type="button" variant="outline">
          Cancel
        </Button>
        <Button disabled={save.isPending} size="sm" type="submit">
          {save.isPending ? <Spinner className="mr-2 h-3.5 w-3.5" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

// ── Custom harness row ────────────────────────────────────────────────────────

function CustomHarnessRow({ entry }: { entry: AcpRuntimeCatalogEntry }) {
  const [editing, setEditing] = React.useState(false);
  const [confirmingDelete, setConfirmingDelete] = React.useState(false);
  const del = useDeleteCustomHarnessMutation();

  if (editing) {
    return (
      <CustomHarnessForm
        initial={{
          id: entry.id,
          label: entry.label,
          command: entry.command ?? "",
          args: (entry.defaultArgs ?? []).join(" "),
          installInstructionsUrl: entry.installInstructionsUrl,
        }}
        onCancel={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />
    );
  }

  return (
    <div
      className="flex items-center gap-3 rounded-2xl border border-border/60 bg-muted/20 px-4 py-3 text-sm"
      data-testid={`custom-harness-row-${entry.id}`}
    >
      <Terminal className="h-6 w-6 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-medium leading-none">{entry.label}</p>
        <p className="mt-0.5 font-mono text-xs text-muted-foreground">
          {entry.command ?? entry.id}
          {(entry.defaultArgs ?? []).length > 0
            ? " " + (entry.defaultArgs ?? []).join(" ")
            : ""}
        </p>
      </div>
      {entry.availability === "available" ? (
        <span className="inline-flex shrink-0 items-center rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          Detected
        </span>
      ) : (
        <span className="inline-flex shrink-0 items-center rounded-md bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          Not installed
        </span>
      )}
      <div className="flex shrink-0 items-center gap-1">
        <Button
          className="h-7 px-3 text-xs"
          data-testid={`custom-harness-edit-${entry.id}`}
          onClick={() => setEditing(true)}
          size="sm"
          type="button"
          variant="outline"
        >
          Edit
        </Button>
        {confirmingDelete ? (
          <>
            <Button
              className="h-7 px-3 text-xs"
              data-testid={`custom-harness-delete-confirm-${entry.id}`}
              disabled={del.isPending}
              onClick={() => {
                void del.mutateAsync(entry.id).catch(() => {});
                setConfirmingDelete(false);
              }}
              size="sm"
              type="button"
              variant="destructive"
            >
              {del.isPending ? <Spinner className="h-3.5 w-3.5" /> : "Delete"}
            </Button>
            <Button
              className="h-7 px-3 text-xs"
              onClick={() => setConfirmingDelete(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
          </>
        ) : (
          <button
            aria-label={`Delete ${entry.label}`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            data-testid={`custom-harness-delete-${entry.id}`}
            onClick={() => setConfirmingDelete(true)}
            type="button"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function HarnessManagementCard() {
  const runtimesQuery = useAcpRuntimesQuery();
  const catalog = runtimesQuery.data ?? [];
  const [showForm, setShowForm] = React.useState(false);
  const [presetPrefill, setPresetPrefill] = React.useState<
    Partial<CustomFormValues> | undefined
  >(undefined);

  const customEntries = catalog.filter((e) => e.source === "custom");

  function handlePresetAdd(preset: HarnessPreset) {
    setPresetPrefill({
      id: preset.id,
      label: preset.label,
      command: preset.command,
      args: preset.args.join(" "),
      installInstructionsUrl: preset.installInstructionsUrl,
    });
    setShowForm(true);
  }

  function handleFormClose() {
    setShowForm(false);
    setPresetPrefill(undefined);
  }

  return (
    <section
      className="min-w-0 space-y-4"
      data-testid="settings-harness-management"
    >
      <SettingsSectionHeader
        title="Bring your own harness"
        description="Register any ACP-speaking agent tool as a selectable runtime. Pick from presets or add a custom command."
      />

      {/* Preset gallery */}
      <div className="space-y-3">
        <p className="text-sm font-medium">Presets</p>
        <div
          className="grid grid-cols-1 gap-3 sm:grid-cols-2"
          data-testid="harness-preset-gallery"
        >
          {HARNESS_PRESETS.map((preset) => (
            <PresetCard
              catalog={catalog}
              key={preset.id}
              onAdd={handlePresetAdd}
              preset={preset}
            />
          ))}
        </div>
      </div>

      {/* Custom harnesses list */}
      {customEntries.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm font-medium">Custom harnesses</p>
          <div className="space-y-2" data-testid="custom-harness-list">
            {customEntries.map((entry) => (
              <CustomHarnessRow entry={entry} key={entry.id} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Add custom / form toggle */}
      {showForm ? (
        <CustomHarnessForm
          initial={presetPrefill}
          onCancel={handleFormClose}
          onSaved={handleFormClose}
        />
      ) : (
        <Button
          className="gap-2"
          data-testid="harness-add-custom-button"
          onClick={() => {
            setPresetPrefill(undefined);
            setShowForm(true);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Plus className="h-4 w-4" />
          Add custom harness
        </Button>
      )}

      {runtimesQuery.error instanceof Error ? (
        <p className="rounded-2xl bg-destructive/10 px-4 py-4 text-sm text-destructive">
          {runtimesQuery.error.message}
        </p>
      ) : null}
    </section>
  );
}
