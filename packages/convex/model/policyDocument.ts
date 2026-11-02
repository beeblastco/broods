// Imports only `convex/values`, so the schema can read it without a cycle.
import { v, type Infer } from "convex/values";

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

// `resourceIds` is for API-action rules, where "*" matches every id.
const policyResourceSelectorValidator = v.object({
  toolNames: v.optional(v.array(v.string())),
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

// An omitted `mode` reads as "audit".
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
