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

export const rolePrincipalValidator = v.object({
  accountId: v.id("accounts"),
  roleId: v.string(),
  policy: policyDocumentValidator,
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
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

export type PolicyCondition = Infer<typeof policyConditionValidator>;

export type PolicyDocument = Infer<typeof policyDocumentValidator>;

export type PolicyEffect = PolicyRule["effect"];

export type PolicyResourceSelector = Infer<
  typeof policyResourceSelectorValidator
>;

export type PolicyRule = Infer<typeof policyRuleValidator>;
