/**
 * The policy document as the `agentPolicies` and `accountRoles` tables
 * store it: a version, a mode, and rules over actions with optional
 * resource selectors and conditions. Only `convex/values` is imported here,
 * so the schema can read it without a cycle; the normalizer and the
 * evaluators live beside it in `policyRules.ts`.
 */

import { v, type Infer } from "convex/values";

/** The condition operators a rule may use, with the word the lists print. */
export const POLICY_CONDITION_OPERATORS = [
  { value: "equals", label: "=" },
  { value: "notEquals", label: "≠" },
  { value: "in", label: "in" },
  { value: "notIn", label: "not in" },
  { value: "prefix", label: "starts with" },
  { value: "contains", label: "contains" },
] as const;

export type PolicyConditionOperator =
  (typeof POLICY_CONDITION_OPERATORS)[number]["value"];

const policyConditionValidator = v.object({
  attribute: v.string(),
  operator: v.union(
    ...POLICY_CONDITION_OPERATORS.map((operator) => v.literal(operator.value)),
  ),
  value: v.union(
    v.string(),
    v.number(),
    v.boolean(),
    v.array(v.string()),
    v.array(v.number()),
    v.array(v.boolean()),
  ),
});

/** Which things a rule's actions reach; `resourceIds` is for API-action rules, "*" matching every id. */
const policyResourceSelectorValidator = v.object({
  toolNames: v.optional(v.array(v.string())),
  /** MCP registration ids, for scoping tool.call rules per server (#331). */
  mcpIds: v.optional(v.array(v.string())),
  workspaceIds: v.optional(v.array(v.string())),
  workspaceNames: v.optional(v.array(v.string())),
  filePaths: v.optional(v.array(v.string())),
  subagentIds: v.optional(v.array(v.string())),
  skillPaths: v.optional(v.array(v.string())),
  resourceIds: v.optional(v.array(v.string())),
});

const policyRuleValidator = v.object({
  id: v.string(),
  effect: v.union(v.literal("allow"), v.literal("deny")),
  actions: v.array(v.string()),
  resources: v.optional(policyResourceSelectorValidator),
  conditions: v.optional(v.array(policyConditionValidator)),
});

/**
 * Versioned policy document accepted by account-management CRUD, as the
 * `agentPolicies` and `accountRoles` tables store it. `mode` says how hard
 * the policy bites where it is attached; omitted reads as `audit`.
 */
export const policyDocumentValidator = v.object({
  version: v.literal(1),
  mode: v.optional(v.union(v.literal("enforce"), v.literal("audit"))),
  rules: v.array(policyRuleValidator),
});

export type PolicyCondition = Infer<typeof policyConditionValidator>;

export type PolicyDocument = Infer<typeof policyDocumentValidator>;

export type PolicyEffect = PolicyRule["effect"];

export type PolicyResourceSelector = Infer<
  typeof policyResourceSelectorValidator
>;

export type PolicyRule = Infer<typeof policyRuleValidator>;
