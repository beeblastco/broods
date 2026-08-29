/**
 * Agent policy runtime contracts: records, ids, attachment validation, and the
 * OPA decision input/output shapes. Document validation lives in the config
 * plane (packages/convex/model/policyRules.ts); runtime decisions are made by
 * OPA using the same document/input shape.
 */

import type {
  PolicyAction,
  PolicyDocument,
} from "@broods/convex/model/policyRules";
import { randomBytes } from "node:crypto";
import { assertOptionalStringArray } from "../object.ts";

export type {
  PolicyAction,
  PolicyDocument,
} from "@broods/convex/model/policyRules";

export type PolicyMode = "enforce" | "audit";

export interface PolicyRecord {
  accountId: string;
  policyId: string;
  name: string;
  description?: string;
  document: PolicyDocument;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDecisionInput {
  action: PolicyAction;
  accountId?: string;
  project?: string;
  stage?: string;
  endpointId?: string;
  agentId?: string;
  conversationKey?: string;
  delivery?: string;
  /** Adapter name, e.g. "slack". The place is `channelId`, not this. */
  channel?: string;
  /** Provider id of the channel the turn arrived in, e.g. a Slack channel id. */
  channelId?: string;
  /** Thread inside that channel, when the turn is threaded. */
  threadId?: string;
  /** The person who addressed the agent, so a rule can be scoped to people. */
  userId?: string;
  userName?: string;
  /** Ids of the channel record's roles the user holds, when one is configured. */
  userRoles?: string[];
  toolName?: string;
  toolId?: string;
  /** MCP registration id behind the tool, when the tool is a remote MCP tool. */
  mcpId?: string;
  workspaceId?: string;
  workspaceName?: string;
  filePath?: string;
  subagentId?: string;
  skillPath?: string;
  sandboxPermissionMode?: string;
  tool?: {
    input?: Record<string, unknown>;
    inputKeys?: string[];
    inputPreview?: string;
  };
}

export interface PolicyDecision {
  allowed: boolean;
  mode: PolicyMode;
  reason: string;
  matchedRuleIds: string[];
  /** Deny rules that fired but only recorded, because their policy is auditing. */
  auditedRuleIds: string[];
}

export function createPolicyId(): string {
  return `policy_${randomBytes(12).toString("base64url")}`;
}

/**
 * Validates the policy ids attached to an agent or a channel. Attachment is
 * just the list: how hard each one bites is carried by the policy itself.
 */
export function normalizePolicyIds(
  value: unknown,
  field: string,
): string[] | undefined {
  if (value == null) return undefined;
  assertOptionalStringArray(value, field);
  const ids = [...new Set(value as string[])];

  return ids.length > 0 ? ids : undefined;
}
