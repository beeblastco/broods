/**
 * Agent policy contracts and validation.
 * Runtime decisions are made by OPA using the same document/input shape.
 */

import { randomBytes } from "node:crypto";
import { assertOptionalStringArray, isPlainObject } from "../object.ts";

export const POLICY_ACTIONS = [
  // Gates the turn itself, before any tool runs: "may this person address the
  // agent here?". Everything below gates one action inside an admitted turn.
  "agent.invoke",
  "tool.call",
  "workspace.read",
  "workspace.write",
  "workspace.exec",
  "subagent.run",
  "skill.load",
] as const;

export type PolicyAction = (typeof POLICY_ACTIONS)[number];
export type PolicyEffect = "allow" | "deny";
export type PolicyMode = "enforce" | "audit";
export type PolicyConditionOperator =
  "equals" | "notEquals" | "in" | "notIn" | "prefix" | "contains";

export interface PolicyCondition {
  attribute: string;
  operator: PolicyConditionOperator;
  value: string | number | boolean | string[] | number[] | boolean[];
}

export interface PolicyResourceSelector {
  toolNames?: string[];
  toolIds?: string[];
  workspaceIds?: string[];
  workspaceNames?: string[];
  filePaths?: string[];
  subagentIds?: string[];
  skillPaths?: string[];
}

export interface PolicyRule {
  id: string;
  effect: PolicyEffect;
  actions: PolicyAction[];
  resources?: PolicyResourceSelector;
  conditions?: PolicyCondition[];
}

export interface PolicyDocument {
  version: 1;
  /**
   * How hard this policy bites. `audit` records what it would have done and
   * blocks nothing; `enforce` lets its deny rules refuse, and switches the
   * places it is attached to over to default-deny. Omitted reads as `audit`,
   * so a freshly written policy can never break a running agent.
   */
  mode?: PolicyMode;
  rules: PolicyRule[];
}

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

export interface CreatePolicyInput {
  name: string;
  description?: string;
  document: unknown;
}

export interface UpdatePolicyInput {
  name?: string;
  description?: string | null;
  document?: unknown;
  status?: PolicyRecord["status"];
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

export function normalizeCreatePolicyInput(
  value: CreatePolicyInput,
): CreatePolicyInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const name = requireString(value.name, "name");
  const description = optionalString(value.description, "description");
  const document = normalizePolicyDocument(value.document);

  return {
    name: name,
    ...(description ? { description: description } : {}),
    document: document,
  };
}

export function normalizeUpdatePolicyInput(
  value: UpdatePolicyInput,
): UpdatePolicyInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const patch: UpdatePolicyInput = {};
  if (value.name !== undefined) patch.name = requireString(value.name, "name");
  if (value.description !== undefined)
    patch.description =
      value.description === null
        ? null
        : optionalString(value.description, "description");
  if (value.document !== undefined)
    patch.document = normalizePolicyDocument(value.document);
  if (value.status !== undefined) {
    if (value.status !== "active" && value.status !== "deleted") {
      throw new Error("status must be one of: active, deleted");
    }
    patch.status = value.status;
  }

  return patch;
}

export function normalizePolicyDocument(value: unknown): PolicyDocument {
  if (!isPlainObject(value))
    throw new Error("policy document must be an object");
  const document = value as Record<string, unknown>;
  if (document.version !== 1)
    throw new Error("policy document version must be 1");
  if (!Array.isArray(document.rules))
    throw new Error("policy document rules must be an array");

  assertOptionalEnum(document.mode, "policy document mode", [
    "enforce",
    "audit",
  ]);

  return {
    version: 1,
    ...(document.mode !== undefined
      ? { mode: document.mode as PolicyMode }
      : {}),
    rules: document.rules.map((rule, index) =>
      normalizePolicyRule(rule, index),
    ),
  };
}

function normalizePolicyRule(value: unknown, index: number): PolicyRule {
  if (!isPlainObject(value))
    throw new Error(`policy rules[${index}] must be an object`);
  const rule = value as Record<string, unknown>;
  const id =
    optionalString(rule.id, `policy rules[${index}].id`) ?? `rule-${index + 1}`;
  assertOptionalEnum(rule.effect, `policy rules[${index}].effect`, [
    "allow",
    "deny",
  ]);
  if (rule.effect === undefined)
    throw new Error(`policy rules[${index}].effect is required`);
  if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
    throw new Error(`policy rules[${index}].actions must be a non-empty array`);
  }
  for (const action of rule.actions) {
    assertOptionalEnum(
      action,
      `policy rules[${index}].actions[]`,
      POLICY_ACTIONS,
    );
  }

  return {
    id: id,
    effect: rule.effect as PolicyEffect,
    actions: rule.actions as PolicyAction[],
    ...(rule.resources !== undefined
      ? { resources: normalizeResourceSelector(rule.resources, index) }
      : {}),
    ...(rule.conditions !== undefined
      ? { conditions: normalizeConditions(rule.conditions, index) }
      : {}),
  };
}

const RESOURCE_SELECTOR_KEYS = [
  "toolNames",
  "toolIds",
  "workspaceIds",
  "workspaceNames",
  "filePaths",
  "subagentIds",
  "skillPaths",
] as const;

function normalizeResourceSelector(
  value: unknown,
  index: number,
): PolicyResourceSelector {
  if (!isPlainObject(value))
    throw new Error(`policy rules[${index}].resources must be an object`);
  const selector = value as Record<string, unknown>;
  for (const key of Object.keys(selector)) {
    if (
      !RESOURCE_SELECTOR_KEYS.includes(
        key as (typeof RESOURCE_SELECTOR_KEYS)[number],
      )
    ) {
      throw new Error(
        `policy rules[${index}].resources.${key} is not supported`,
      );
    }
  }
  for (const key of RESOURCE_SELECTOR_KEYS) {
    assertOptionalStringArray(
      selector[key],
      `policy rules[${index}].resources.${key}`,
    );
  }

  return selector as PolicyResourceSelector;
}

function normalizeConditions(value: unknown, index: number): PolicyCondition[] {
  if (!Array.isArray(value))
    throw new Error(`policy rules[${index}].conditions must be an array`);

  return value.map((condition, conditionIndex) => {
    if (!isPlainObject(condition)) {
      throw new Error(
        `policy rules[${index}].conditions[${conditionIndex}] must be an object`,
      );
    }
    const record = condition as Record<string, unknown>;
    const attribute = requireString(
      record.attribute,
      `policy rules[${index}].conditions[${conditionIndex}].attribute`,
    );
    assertOptionalEnum(
      record.operator,
      `policy rules[${index}].conditions[${conditionIndex}].operator`,
      ["equals", "notEquals", "in", "notIn", "prefix", "contains"],
    );
    if (record.operator === undefined) {
      throw new Error(
        `policy rules[${index}].conditions[${conditionIndex}].operator is required`,
      );
    }
    if (!isConditionValue(record.value)) {
      throw new Error(
        `policy rules[${index}].conditions[${conditionIndex}].value is invalid`,
      );
    }
    // A scalar here matches no rego branch, so the condition never fires — which
    // on notIn means the deny silently never applies. Refuse it instead.
    if (
      (record.operator === "in" || record.operator === "notIn") &&
      !Array.isArray(record.value)
    ) {
      throw new Error(
        `policy rules[${index}].conditions[${conditionIndex}].value must be an array when operator is ${record.operator}; use ${record.operator === "in" ? "equals" : "notEquals"} to compare one value`,
      );
    }

    return {
      attribute: attribute,
      operator: record.operator as PolicyConditionOperator,
      value: record.value,
    };
  });
}

function isConditionValue(value: unknown): value is PolicyCondition["value"] {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return true;
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  // The declared union is homogeneous (string[] | number[] | boolean[]); a
  // mixed array would hand OPA a shape the contract does not allow.
  const elementType = typeof value[0];
  if (
    elementType !== "string" &&
    elementType !== "number" &&
    elementType !== "boolean"
  )
    return false;

  return value.every((entry) => typeof entry === elementType);
}

function assertOptionalEnum<T extends readonly string[]>(
  value: unknown,
  name: string,
  values: T,
): void {
  if (value !== undefined && !values.includes(value as T[number])) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);

  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}
