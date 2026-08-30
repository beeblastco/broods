/**
 * Agent-policy validation for the Convex config plane. Ports core's public
 * CRUD normalizer so policy documents keep the account-management API
 * contract. The public projection lives in ./responses.ts.
 */

import { isPlainObject } from "./objects";

export const AGENT_POLICY_ACTIONS = [
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

/**
 * API action namespace for account roles: one read/write pair per config-plane
 * resource route. Roles carry the same PolicyDocument shape as agent policies;
 * each caller passes its action set to `normalizePolicyDocument`.
 */
export const API_POLICY_ACTIONS = [
  "account:read",
  "account:write",
  "agents:read",
  "agents:write",
  "channels:read",
  "channels:write",
  "crons:read",
  "crons:write",
  "env:read",
  "env:write",
  "hooks:read",
  "hooks:write",
  "mcp:read",
  "mcp:write",
  "policies:read",
  "policies:write",
  "sandboxes:read",
  "sandboxes:write",
  "skills:read",
  "skills:write",
  "tools:read",
  "tools:write",
  "workspaces:read",
  "workspaces:write",
] as const;

const RESOURCE_SELECTOR_KEYS = [
  "toolNames",
  "mcpIds",
  "workspaceIds",
  "workspaceNames",
  "filePaths",
  "subagentIds",
  "skillPaths",
  "resourceIds",
] as const;

export type AgentPolicyAction = (typeof AGENT_POLICY_ACTIONS)[number];

export type ApiPolicyAction = (typeof API_POLICY_ACTIONS)[number];

export type PolicyAction = AgentPolicyAction | ApiPolicyAction;

/**
 * One optional predicate on a policy rule.
 */
export interface PolicyCondition {
  attribute: string;
  operator: PolicyConditionOperator;
  value: string | number | boolean | string[] | number[] | boolean[];
}

export type PolicyConditionOperator =
  | "equals"
  | "notEquals"
  | "in"
  | "notIn"
  | "prefix"
  | "contains";

/**
 * Versioned policy document accepted by account-management CRUD.
 */
export interface PolicyDocument {
  version: 1;
  /** How hard this policy bites where it is attached. Omitted reads as `audit`. */
  mode?: "enforce" | "audit";
  rules: PolicyRule[];
}

export type PolicyEffect = "allow" | "deny";

/**
 * Resource selector fields supported by policy rules.
 */
export interface PolicyResourceSelector {
  toolNames?: string[];
  /** MCP registration ids, for scoping tool.call rules per server (#331). */
  mcpIds?: string[];
  workspaceIds?: string[];
  workspaceNames?: string[];
  filePaths?: string[];
  subagentIds?: string[];
  skillPaths?: string[];
  /** Config-plane resource ids for API-action rules; "*" matches every id. */
  resourceIds?: string[];
}

/**
 * One allow/deny rule inside a policy document.
 */
export interface PolicyRule {
  id: string;
  effect: PolicyEffect;
  actions: PolicyAction[];
  resources?: PolicyResourceSelector;
  conditions?: PolicyCondition[];
}

/**
 * Validate a create-policy request body.
 * @param value the raw request body
 * @returns normalized create fields
 */
export function normalizeCreatePolicyInput(value: unknown): {
  name: string;
  description?: string;
  document: PolicyDocument;
} {
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

/**
 * Validate and normalize a versioned policy document. Agent policies accept
 * the runtime action set by default; role policies pass `API_POLICY_ACTIONS`.
 */
export function normalizePolicyDocument(
  value: unknown,
  allowedActions: readonly PolicyAction[] = AGENT_POLICY_ACTIONS,
): PolicyDocument {
  if (!isPlainObject(value))
    throw new Error("policy document must be an object");
  const document = value;
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
      ? { mode: document.mode as "enforce" | "audit" }
      : {}),
    rules: document.rules.map((rule, index) =>
      normalizePolicyRule(rule, index, allowedActions),
    ),
  };
}

/**
 * Validate an update-policy request body.
 * @param value the raw request body
 * @returns normalized patch fields
 */
export function normalizeUpdatePolicyInput(value: unknown): {
  name?: string;
  description?: string | null;
  document?: PolicyDocument;
  status?: "active" | "deleted";
} {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  const patch: {
    name?: string;
    description?: string | null;
    document?: PolicyDocument;
    status?: "active" | "deleted";
  } = {};
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

function assertOptionalEnum<T extends readonly string[]>(
  value: unknown,
  name: string,
  values: T,
): void {
  if (value !== undefined && !values.includes(value as T[number])) {
    throw new Error(`${name} must be one of: ${values.join(", ")}`);
  }
}

function assertOptionalStringArray(value: unknown, name: string): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      !value.every(
        (entry) => typeof entry === "string" && entry.trim().length > 0,
      ))
  ) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
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
  const elementType = typeof value[0];
  if (
    elementType !== "string" &&
    elementType !== "number" &&
    elementType !== "boolean"
  )
    return false;

  return value.every((entry) => typeof entry === elementType);
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
    const record = condition;
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

function normalizePolicyRule(
  value: unknown,
  index: number,
  allowedActions: readonly PolicyAction[],
): PolicyRule {
  if (!isPlainObject(value))
    throw new Error(`policy rules[${index}] must be an object`);
  const rule = value;
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
      allowedActions,
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

function normalizeResourceSelector(
  value: unknown,
  index: number,
): PolicyResourceSelector {
  if (!isPlainObject(value))
    throw new Error(`policy rules[${index}].resources must be an object`);
  const selector = value;
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

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);

  return value.trim();
}
