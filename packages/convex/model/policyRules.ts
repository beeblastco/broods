import { z } from "zod/mini";

import { ClientError } from "./clientError";
import {
  nonEmptyString,
  nonEmptyStrings,
  parseInput,
  unsupportedKeys,
  wholeValue,
} from "./inputSchema";
import {
  POLICY_CONDITION_OPERATORS,
  type PolicyDocument,
  type PolicyRule,
} from "./policyDocument";

export {
  POLICY_CONDITION_OPERATORS,
  policyDocumentValidator,
  type PolicyCondition,
  type PolicyConditionOperator,
  type PolicyDocument,
  type PolicyEffect,
  type PolicyResourceSelector,
  type PolicyRule,
} from "./policyDocument";

export const AGENT_POLICY_ACTIONS = [
  // Gates admitting the turn; the rest gate one action inside an admitted turn.
  "agent.invoke",
  "tool.call",
  "workspace.read",
  "workspace.write",
  "workspace.exec",
  "subagent.run",
  "skill.load",
] as const;

export const API_POLICY_ACTIONS = [
  "account:read",
  "account:write",
  "agents:read",
  "agents:write",
  "audit:read",
  "audit:write",
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
  "workspaces:read",
  "workspaces:write",
] as const;

export const DASHBOARD_POLICY_ACTIONS = [
  "keys:read",
  "keys:write",
  "members:write",
  "access:write",
] as const;

export const DASHBOARD_DESCRIPTIONS: Record<DashboardPolicyAction, string> = {
  "keys:read": "See keys",
  "keys:write": "Make, rotate and revoke keys",
  "members:write": "Change members and their roles",
  "access:write": "Change permissions, policies and roles",
};

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

const optionalStrings = z.optional(nonEmptyStrings);
const REQUIRED_ERROR = (issue: z.core.$ZodRawIssue): string | undefined =>
  issue.input === undefined ? "is required" : undefined;
const POLICY_INPUT = {
  name: nonEmptyString,
  description: z.optional(z.string()),
  document: z.optional(z.unknown()),
};
const CREATE_POLICY_INPUT = z.looseObject(POLICY_INPUT, {
  error: "Request body must be an object",
});
const UPDATE_POLICY_INPUT = z.looseObject(
  {
    ...POLICY_INPUT,
    name: z.optional(nonEmptyString),
    description: z.optional(z.nullable(z.string())),
    status: z.optional(z.enum(["active", "deleted"])),
  },
  { error: "Request body must be an object" },
);
const POLICY_DOCUMENT = z.looseObject({
  version: z.literal(1, { error: "must be 1" }),
  rules: z.array(z.unknown()),
  mode: z.optional(z.enum(["enforce", "audit"])),
});
const POLICY_CONDITION = z
  .looseObject({
    attribute: nonEmptyString,
    operator: z.enum(
      POLICY_CONDITION_OPERATORS.map((operator) => operator.value),
      { error: REQUIRED_ERROR },
    ),
    value: wholeValue(
      z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.array(z.string()),
        z.array(z.number()),
        z.array(z.boolean()),
      ]),
      "is invalid",
    ),
  })
  .check(
    z.superRefine((condition, ctx): void => {
      const { operator } = condition;
      // A scalar matches no rego branch, so a notIn deny would silently never apply.
      if (
        (operator === "in" || operator === "notIn") &&
        !Array.isArray(condition.value)
      )
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: `must be an array when operator is ${operator}; use ${operator === "in" ? "equals" : "notEquals"} to compare one value`,
        });
    }),
  );
const POLICY_RULE = z.looseObject({
  id: z.optional(z.string()),
  effect: z.enum(["allow", "deny"], { error: REQUIRED_ERROR }),
  actions: z
    .array(z.unknown(), { error: "must be a non-empty array" })
    .check(z.minLength(1, { error: "must be a non-empty array" })),
  resources: z.optional(
    z
      .looseObject({
        toolNames: optionalStrings,
        mcpIds: optionalStrings,
        workspaceIds: optionalStrings,
        workspaceNames: optionalStrings,
        filePaths: optionalStrings,
        subagentIds: optionalStrings,
        skillPaths: optionalStrings,
        resourceIds: optionalStrings,
      })
      .check(unsupportedKeys(RESOURCE_SELECTOR_KEYS)),
  ),
  conditions: z.optional(z.array(POLICY_CONDITION)),
});

export type AgentPolicyAction = (typeof AGENT_POLICY_ACTIONS)[number];

export type ApiPolicyAction = (typeof API_POLICY_ACTIONS)[number];

export type DashboardPolicyAction = (typeof DASHBOARD_POLICY_ACTIONS)[number];

// `string & {}` admits a custom permission (`tool.stripe.refund`) yet keeps built-ins suggested.
export type PolicyAction =
  | AgentPolicyAction
  | ApiPolicyAction
  | DashboardPolicyAction
  | (string & {});

export function normalizeCreatePolicyInput(value: unknown): {
  name: string;
  description?: string;
  document: PolicyDocument;
} {
  const input = parseInput(CREATE_POLICY_INPUT, value, "");
  const description = input.description?.trim();

  return {
    name: input.name.trim(),
    ...(description ? { description: description } : {}),
    document: normalizePolicyDocument(input.document),
  };
}

export function normalizePolicyDocument(
  value: unknown,
  allowedActions: readonly string[] = AGENT_POLICY_ACTIONS,
): PolicyDocument {
  const document = parseInput(POLICY_DOCUMENT, value, "policy document ");

  return {
    version: 1,
    ...(document.mode !== undefined ? { mode: document.mode } : {}),
    rules: document.rules.map((rule, index) =>
      normalizePolicyRule(rule, index, allowedActions),
    ),
  };
}

export function normalizeUpdatePolicyInput(value: unknown): {
  name?: string;
  description?: string | null;
  document?: PolicyDocument;
  status?: "active" | "deleted";
} {
  const input = parseInput(UPDATE_POLICY_INPUT, value, "");

  return {
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined
      ? {
          description:
            input.description === null
              ? null
              : input.description.trim() || undefined,
        }
      : {}),
    ...(input.document !== undefined
      ? { document: normalizePolicyDocument(input.document) }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  };
}

function normalizePolicyRule(
  value: unknown,
  index: number,
  allowedActions: readonly string[],
): PolicyRule {
  const path = `policy rules[${index}]`;
  const rule = parseInput(POLICY_RULE, value, path);
  const actions = rule.actions.map((action): string => {
    if (
      action !== undefined &&
      !allowedActions.some((allowed) => allowed === action)
    )
      throw new ClientError(
        `${path}.actions[] must be one of: ${allowedActions.join(", ")}`,
      );
    if (typeof action !== "string")
      throw new ClientError(`${path}.actions[] must be strings`);

    return action;
  });

  return {
    id: rule.id?.trim() || `rule-${index + 1}`,
    effect: rule.effect,
    actions: actions,
    ...(rule.resources !== undefined ? { resources: rule.resources } : {}),
    ...(rule.conditions !== undefined
      ? {
          conditions: rule.conditions.map((condition) => ({
            attribute: condition.attribute.trim(),
            operator: condition.operator,
            value: condition.value,
          })),
        }
      : {}),
  };
}
