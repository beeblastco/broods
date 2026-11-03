// Apart from the model/*Rules validators, which stay free of `_generated` imports for core.

import { v, type Infer } from "convex/values";

import type { Doc } from "../_generated/dataModel";
import type { AgentConfig } from "./agentRules";
import { redactConfigSecrets, REDACTED_SECRET_VALUE } from "./configValues";
import type { SandboxConfig } from "./sandboxRules";

// The crons table fields as the API returns them: timestamps as ISO strings, no internals.
export const cronResponseValidator = v.object({
  accountId: v.id("accounts"),
  cronId: v.id("crons"),
  name: v.string(),
  description: v.optional(v.string()),
  agentId: v.id("agents"),
  events: v.array(v.any()),
  conversationKey: v.optional(v.string()),
  scheduleExpression: v.string(),
  timezone: v.optional(v.string()),
  status: v.union(v.literal("active"), v.literal("paused")),
  createdAt: v.string(),
  updatedAt: v.string(),
  lastInvokedAt: v.optional(v.string()),
  lastStatus: v.optional(
    v.union(v.literal("started"), v.literal("completed"), v.literal("failed")),
  ),
  lastError: v.optional(v.string()),
});

export type CronResponse = Infer<typeof cronResponseValidator>;

export function toCronResponse(doc: Doc<"crons">): CronResponse {
  return {
    accountId: doc.accountId,
    cronId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    agentId: doc.agentId,
    events: doc.events,
    ...(doc.conversationKey ? { conversationKey: doc.conversationKey } : {}),
    scheduleExpression: doc.scheduleExpression,
    ...(doc.timezone ? { timezone: doc.timezone } : {}),
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
    ...(doc.lastInvokedAt
      ? { lastInvokedAt: new Date(doc.lastInvokedAt).toISOString() }
      : {}),
    ...(doc.lastStatus ? { lastStatus: doc.lastStatus } : {}),
    ...(doc.lastError ? { lastError: doc.lastError } : {}),
  };
}

export function toCronRunResponse(
  doc: Doc<"cronRuns">,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    cronId: doc.cronId,
    runId: doc._id,
    eventId: doc.eventId,
    conversationKey: doc.conversationKey,
    status: doc.status,
    ...(doc.result !== undefined ? { result: doc.result } : {}),
    ...(doc.error ? { error: doc.error } : {}),
    startedAt: new Date(doc.startedAt).toISOString(),
    ...(doc.completedAt
      ? { completedAt: new Date(doc.completedAt).toISOString() }
      : {}),
  };
}

export function toPublicAgentPolicyResponse(
  doc: Doc<"agentPolicies">,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    policyId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    document: doc.document,
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export function toPublicAgentResponse(
  doc: Doc<"agents">,
  config: AgentConfig,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    agentId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    status: "active",
    config: redactConfigSecrets(config),
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export function toPublicChannelRecordResponse(
  doc: Doc<"channelRecords">,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    channelId: doc._id,
    platform: doc.platform,
    externalId: doc.externalId,
    ...(doc.workspaceRef ? { workspaceRef: doc.workspaceRef } : {}),
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: doc.config,
    status: doc.status,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export function toPublicRoleResponse(
  doc: Omit<Doc<"accountRoles">, "_id" | "_creationTime">,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    roleId: doc.roleId,
    name: doc.name,
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    ...(doc.stageId ? { stageId: doc.stageId } : {}),
    status: doc.status,
    policy: doc.policy,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export function toPublicSandboxConfigResponse(
  doc: Doc<"sandboxConfigs">,
  config: SandboxConfig,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    sandboxId: doc._id,
    ...(doc.projectId ? { projectId: doc.projectId } : {}),
    ...(doc.stageId ? { stageId: doc.stageId } : {}),
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: redactSandboxConfigSecrets(config),
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

export function toPublicWorkspaceConfigResponse(
  doc: Doc<"workspaceConfigs">,
): Record<string, unknown> {
  return {
    accountId: doc.accountId,
    workspaceId: doc._id,
    name: doc.name,
    ...(doc.description ? { description: doc.description } : {}),
    config: doc.config ?? { storage: { provider: "s3" } },
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

function redactSandboxConfigSecrets(config: SandboxConfig): SandboxConfig {
  const redacted = redactConfigSecrets(config);
  if (redacted.envVars) {
    redacted.envVars = Object.fromEntries(
      Object.keys(redacted.envVars).map((key) => [key, REDACTED_SECRET_VALUE]),
    );
  }

  return redacted;
}
