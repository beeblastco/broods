/**
 * Agent policy contracts and validation.
 * Runtime decisions are made by OPA using the same document/input shape.
 */

import { isPlainObject } from "../object.ts";
import { randomBytes } from "node:crypto";

export const AGENT_POLICY_ACTIONS = [
  "tool.call",
  "workspace.read",
  "workspace.write",
  "workspace.exec",
  "subagent.run",
  "skill.load",
] as const;

export type AgentPolicyAction = (typeof AGENT_POLICY_ACTIONS)[number];
export type AgentPolicyEffect = "allow" | "deny";
export type AgentPolicyMode = "enforce" | "audit";
export type AgentPolicyConditionOperator = "equals" | "notEquals" | "in" | "notIn" | "prefix" | "contains";

export interface AgentPolicyCondition {
  attribute: string;
  operator: AgentPolicyConditionOperator;
  value: string | number | boolean | string[] | number[] | boolean[];
}

export interface AgentPolicyResourceSelector {
  toolNames?: string[];
  toolIds?: string[];
  workspaceIds?: string[];
  workspaceNames?: string[];
  filePaths?: string[];
  subagentIds?: string[];
  skillPaths?: string[];
}

export interface AgentPolicyRule {
  id: string;
  effect: AgentPolicyEffect;
  actions: AgentPolicyAction[];
  resources?: AgentPolicyResourceSelector;
  conditions?: AgentPolicyCondition[];
}

export interface AgentPolicyDocument {
  version: 1;
  rules: AgentPolicyRule[];
}

export interface AgentPolicyRecord {
  accountId: string;
  policyId: string;
  name: string;
  description?: string;
  document: AgentPolicyDocument;
  status: "active" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export interface AgentPolicyConfig {
  enabled?: boolean;
  policyIds?: string[];
  mode?: AgentPolicyMode;
}

export interface PolicyDecisionInput {
  action: AgentPolicyAction;
  accountId?: string;
  project?: string;
  environment?: string;
  endpointId?: string;
  agentId?: string;
  conversationKey?: string;
  delivery?: string;
  channel?: string;
  toolName?: string;
  toolId?: string;
  workspaceId?: string;
  workspaceName?: string;
  filePath?: string;
  subagentId?: string;
  skillPath?: string;
  sandboxPermissionMode?: string;
}

export interface PolicyDecision {
  allowed: boolean;
  mode: AgentPolicyMode;
  reason: string;
  matchedRuleIds: string[];
}

export interface CreateAgentPolicyInput {
  name: string;
  description?: string;
  document: unknown;
}

export interface UpdateAgentPolicyInput {
  name?: string;
  description?: string | null;
  document?: unknown;
  status?: AgentPolicyRecord["status"];
}

export function createAgentPolicyId(): string {
  return `policy_${randomBytes(12).toString("base64url")}`;
}

export function normalizeAgentPolicyConfig(value: unknown): AgentPolicyConfig | undefined {
  if (value == null) return undefined;
  if (!isPlainObject(value)) throw new Error("config.policy must be an object");
  const config = value as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key !== "enabled" && key !== "policyIds" && key !== "mode") {
      throw new Error(`config.policy.${key} is not supported`);
    }
  }
  assertOptionalBoolean(config.enabled, "config.policy.enabled");
  assertOptionalStringArray(config.policyIds, "config.policy.policyIds");
  assertOptionalEnum(config.mode, "config.policy.mode", ["enforce", "audit"]);

  return {
    ...(config.enabled !== undefined ? { enabled: config.enabled as boolean } : {}),
    ...(config.policyIds !== undefined ? { policyIds: config.policyIds as string[] } : {}),
    ...(config.mode !== undefined ? { mode: config.mode as AgentPolicyMode } : {}),
  };
}

export function normalizeCreateAgentPolicyInput(value: CreateAgentPolicyInput): CreateAgentPolicyInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const description = optionalString(value.description, "description");
  const document = normalizeAgentPolicyDocument(value.document);

  return {
    name,
    ...(description ? { description } : {}),
    document,
  };
}

export function normalizeUpdateAgentPolicyInput(value: UpdateAgentPolicyInput): UpdateAgentPolicyInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const patch: UpdateAgentPolicyInput = {};
  if (value.name !== undefined) patch.name = requireString(value.name, "name");
  if (value.description !== undefined) patch.description = value.description === null ? null : optionalString(value.description, "description");
  if (value.document !== undefined) patch.document = normalizeAgentPolicyDocument(value.document);
  if (value.status !== undefined) {
    if (value.status !== "active" && value.status !== "deleted") {
      throw new Error("status must be one of: active, deleted");
    }
    patch.status = value.status;
  }

  return patch;
}

export function normalizeAgentPolicyDocument(value: unknown): AgentPolicyDocument {
  if (!isPlainObject(value)) throw new Error("policy document must be an object");
  const document = value as Record<string, unknown>;
  if (document.version !== 1) throw new Error("policy document version must be 1");
  if (!Array.isArray(document.rules)) throw new Error("policy document rules must be an array");

  return {
    version: 1,
    rules: document.rules.map((rule, index) => normalizeAgentPolicyRule(rule, index)),
  };
}

function normalizeAgentPolicyRule(value: unknown, index: number): AgentPolicyRule {
  if (!isPlainObject(value)) throw new Error(`policy rules[${index}] must be an object`);
  const rule = value as Record<string, unknown>;
  const id = optionalString(rule.id, `policy rules[${index}].id`) ?? `rule-${index + 1}`;
  assertOptionalEnum(rule.effect, `policy rules[${index}].effect`, ["allow", "deny"]);
  if (rule.effect === undefined) throw new Error(`policy rules[${index}].effect is required`);
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
    throw new Error(`policy rules[${index}].actions must be a non-empty array`);
  }
  for (const action of rule.actions) {
    assertOptionalEnum(action, `policy rules[${index}].actions[]`, AGENT_POLICY_ACTIONS);
  }

  return {
    id,
    effect: rule.effect as AgentPolicyEffect,
    actions: rule.actions as AgentPolicyAction[],
    ...(rule.resources !== undefined ? { resources: normalizeResourceSelector(rule.resources, index) } : {}),
    ...(rule.conditions !== undefined ? { conditions: normalizeConditions(rule.conditions, index) } : {}),
  };
}

const RESOURCE_SELECTOR_KEYS = ["toolNames", "toolIds", "workspaceIds", "workspaceNames", "filePaths", "subagentIds", "skillPaths"] as const;

function normalizeResourceSelector(value: unknown, index: number): AgentPolicyResourceSelector {
  if (!isPlainObject(value)) throw new Error(`policy rules[${index}].resources must be an object`);
  const selector = value as Record<string, unknown>;
  for (const key of Object.keys(selector)) {
    if (!RESOURCE_SELECTOR_KEYS.includes(key as (typeof RESOURCE_SELECTOR_KEYS)[number])) {
      throw new Error(`policy rules[${index}].resources.${key} is not supported`);
    }
  }
  for (const key of RESOURCE_SELECTOR_KEYS) {
    assertOptionalStringArray(selector[key], `policy rules[${index}].resources.${key}`);
  }

  return selector as AgentPolicyResourceSelector;
}

function normalizeConditions(value: unknown, index: number): AgentPolicyCondition[] {
  if (!Array.isArray(value)) throw new Error(`policy rules[${index}].conditions must be an array`);
  return value.map((condition, conditionIndex) => {
    if (!isPlainObject(condition)) {
      throw new Error(`policy rules[${index}].conditions[${conditionIndex}] must be an object`);
    }
    const record = condition as Record<string, unknown>;
    const attribute = requireString(record.attribute, `policy rules[${index}].conditions[${conditionIndex}].attribute`);
    assertOptionalEnum(record.operator, `policy rules[${index}].conditions[${conditionIndex}].operator`, [
      "equals",
      "notEquals",
      "in",
      "notIn",
      "prefix",
      "contains",
    ]);
    if (record.operator === undefined) {
      throw new Error(`policy rules[${index}].conditions[${conditionIndex}].operator is required`);
    }
    if (!isConditionValue(record.value)) {
      throw new Error(`policy rules[${index}].conditions[${conditionIndex}].value is invalid`);
    }

    return {
      attribute,
      operator: record.operator as AgentPolicyConditionOperator,
      value: record.value,
    };
  });
}

function isConditionValue(value: unknown): value is AgentPolicyCondition["value"] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  // The declared union is homogeneous (string[] | number[] | boolean[]); a
  // mixed array would hand OPA a shape the contract does not allow.
  const elementType = typeof value[0];
  if (elementType !== "string" && elementType !== "number" && elementType !== "boolean") return false;
  return value.every((entry) => typeof entry === elementType);
}

function assertOptionalBoolean(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
}

function assertOptionalStringArray(value: unknown, name: string): void {
  if (value !== undefined && (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim().length > 0))) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
}

function assertOptionalEnum<T extends readonly string[]>(value: unknown, name: string, values: T): void {
  if (value !== undefined && !values.includes(value as T[number])) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
