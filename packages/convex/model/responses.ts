/**
 * Public response projections for the Convex config plane: map stored
 * documents (plus decrypted configs) to the account-management API shapes.
 * Lives apart from the model/*Rules validators so those stay free of
 * `_generated` imports and core can typecheck against them directly.
 */

import type { Doc } from "../_generated/dataModel";
import type { AgentConfig } from "./agentRules";
import { redactConfigSecrets, REDACTED_SECRET_VALUE } from "./configValues";
import type { SandboxConfig } from "./sandboxRules";

/**
 * Map a crons document to the public cron shape core used to return
 * (cronId = _id, ISO timestamps, scheduler fields omitted).
 * @param doc the crons document
 * @returns the public cron record
 */
export function toCronResponse(doc: Doc<"crons">): Record<string, unknown> {
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

/**
 * Map a cronRuns document to the public run shape core used to return
 * (runId = _id, ISO timestamps).
 * @param doc the cronRuns document
 * @returns the public run record
 */
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

/**
 * Map an agentPolicies document to the public account-management shape.
 * @param doc the agentPolicies document
 * @returns the public policy record
 */
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

/**
 * Project an agent document and decrypted config to the public API shape.
 * @param doc agent row
 * @param config decrypted config
 * @returns public agent response
 */
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

/**
 * Map a channelRecords document to the public channel-record shape.
 * @param doc the channelRecords document
 * @returns the public channel record
 */
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

/**
 * Map a sandboxConfigs document and decrypted config to the public response.
 * @param doc the sandboxConfigs document
 * @param config decrypted sandbox config
 * @returns the public sandbox record with secrets redacted
 */
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

/**
 * Map a workspaceConfigs document to the public record shape core used to
 * return (workspaceId = _id, ISO timestamps, plaintext config).
 * @param doc the workspaceConfigs document
 * @returns the public workspace record
 */
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
