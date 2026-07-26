import { parse } from "yaml";

import type { RelayEvent } from "@/shared/api/types";

import {
  type Args,
  checkContent,
  firstTagValue,
  parseChannelUuid,
  type RelayContext,
} from "./context.ts";

const KIND_WORKFLOW = 30620;
const KIND_WORKFLOW_TRIGGER = 46020;
const KIND_APPROVAL_GRANT = 46030;
const KIND_APPROVAL_DENY = 46031;

function uuid(value: string, label: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return value.toLowerCase();
}

function definition(yaml: string): Record<string, unknown> {
  try {
    const value = parse(yaml) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function workflowRecord(input: {
  id: string;
  channelId: string | null;
  ownerPubkey: string;
  yaml: string;
  createdAt: number;
  updatedAt: number;
}) {
  const parsed = definition(input.yaml);
  const configuredName =
    typeof parsed.name === "string" ? parsed.name.trim() : "";
  return {
    id: input.id,
    name: configuredName || input.id,
    owner_pubkey: input.ownerPubkey,
    channel_id: input.channelId,
    definition: parsed,
    status: "active",
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
}

function workflowFromEvent(event: RelayEvent) {
  return workflowRecord({
    id: firstTagValue(event, "d") ?? "",
    channelId: firstTagValue(event, "h") ?? null,
    ownerPubkey: event.pubkey,
    yaml: event.content,
    createdAt: event.created_at,
    updatedAt: event.created_at,
  });
}

function responseObject(ctx: RelayContext, message: string) {
  try {
    return ctx.parseCommandResponse<Record<string, unknown>>(message);
  } catch {
    return {};
  }
}

export function workflowHandlers(
  ctx: RelayContext,
): Record<string, (args: Args) => unknown | Promise<unknown>> {
  async function getChannelWorkflows(args: Args) {
    const channelId = parseChannelUuid(args.channelId as string);
    const events = await ctx.relayQuery([
      { kinds: [KIND_WORKFLOW], "#h": [channelId] },
    ]);
    return events.map(workflowFromEvent);
  }

  async function getChannelsWorkflows(args: Args) {
    const channelIds = (args.channelIds as string[]).map(parseChannelUuid);
    if (channelIds.length === 0) return [];
    const events = await ctx.relayQuery([
      { kinds: [KIND_WORKFLOW], "#h": channelIds },
    ]);
    return events.map(workflowFromEvent);
  }

  async function getWorkflow(args: Args) {
    const workflowId = uuid(args.workflowId as string, "workflow id");
    const events = await ctx.relayQuery([
      { kinds: [KIND_WORKFLOW], "#d": [workflowId], limit: 1 },
    ]);
    if (!events[0]) throw new Error("workflow not found");
    return workflowFromEvent(events[0]);
  }

  async function createWorkflow(args: Args) {
    const channelId = parseChannelUuid(args.channelId as string);
    const yaml = args.yamlDefinition as string;
    checkContent(yaml);
    const workflowId = crypto.randomUUID();
    const result = await ctx.submitEvent({
      kind: KIND_WORKFLOW,
      content: yaml,
      tags: [
        ["d", workflowId],
        ["h", channelId],
      ],
    });
    const response = responseObject(ctx, result.message);
    const now = Math.floor(Date.now() / 1_000);
    return {
      ...workflowRecord({
        id: workflowId,
        channelId,
        ownerPubkey: await ctx.myPubkey(),
        yaml,
        createdAt: now,
        updatedAt: now,
      }),
      webhook_secret:
        typeof response.webhook_secret === "string"
          ? response.webhook_secret
          : null,
    };
  }

  async function updateWorkflow(args: Args) {
    const workflowId = uuid(args.workflowId as string, "workflow id");
    const yaml = args.yamlDefinition as string;
    checkContent(yaml);
    const prior = await ctx.relayQuery([
      { kinds: [KIND_WORKFLOW], "#d": [workflowId], limit: 1 },
    ]);
    if (!prior[0]) throw new Error("workflow not found");
    const channelId = firstTagValue(prior[0], "h");
    if (!channelId) throw new Error("workflow not found");
    await ctx.submitEvent({
      kind: KIND_WORKFLOW,
      content: yaml,
      tags: [
        ["d", workflowId],
        ["h", channelId],
      ],
    });
    return {
      ...workflowRecord({
        id: workflowId,
        channelId,
        ownerPubkey: await ctx.myPubkey(),
        yaml,
        createdAt: prior[0].created_at,
        updatedAt: Math.floor(Date.now() / 1_000),
      }),
      webhook_secret: null,
    };
  }

  async function deleteWorkflow(args: Args) {
    const workflowId = uuid(args.workflowId as string, "workflow id");
    const owner = await ctx.myPubkey();
    await ctx.submitEvent({
      kind: 5,
      content: "",
      tags: [["a", `${KIND_WORKFLOW}:${owner}:${workflowId}`]],
    });
  }

  async function triggerWorkflow(args: Args) {
    const workflowId = uuid(args.workflowId as string, "workflow id");
    const result = await ctx.submitEvent({
      kind: KIND_WORKFLOW_TRIGGER,
      content: "",
      tags: [["d", workflowId]],
    });
    const response = responseObject(ctx, result.message);
    return {
      run_id:
        typeof response.run_id === "string" ? response.run_id : result.event_id,
      workflow_id: workflowId,
      status: "queued",
    };
  }

  async function actOnApproval(args: Args, granted: boolean) {
    const token = args.token as string;
    if (!token.trim()) throw new Error("approval token is required");
    const note = (args.note as string | null | undefined) ?? "";
    checkContent(note);
    const result = await ctx.submitEvent({
      kind: granted ? KIND_APPROVAL_GRANT : KIND_APPROVAL_DENY,
      content: note,
      tags: [["t", token]],
    });
    const response = responseObject(ctx, result.message);
    return {
      token,
      status:
        typeof response.status === "string"
          ? response.status
          : granted
            ? "granted"
            : "denied",
      run_id: typeof response.run_id === "string" ? response.run_id : "",
      workflow_id:
        typeof response.workflow_id === "string" ? response.workflow_id : "",
    };
  }

  return {
    get_channel_workflows: getChannelWorkflows,
    get_channels_workflows: getChannelsWorkflows,
    get_workflow: getWorkflow,
    create_workflow: createWorkflow,
    update_workflow: updateWorkflow,
    delete_workflow: deleteWorkflow,
    get_workflow_runs: async () => [],
    get_run_approvals: async () => [],
    trigger_workflow: triggerWorkflow,
    grant_approval: (args) => actOnApproval(args, true),
    deny_approval: (args) => actOnApproval(args, false),
  };
}
