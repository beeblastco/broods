// A member's role policies are the documents core's OPA evaluates for agents, read in the
// same order: a deny wins, then an allow, then nothing. Only enforce-mode policies count.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { getOrgMembership, orgIdOf, type OrgRole } from "./ownership/org";
import {
  DASHBOARD_POLICY_ACTIONS,
  type DashboardPolicyAction,
  type PolicyDocument,
  type PolicyEffect,
  type PolicyRule,
} from "./policyRules";

type Ctx = QueryCtx | MutationCtx;

export interface DashboardScope {
  projectId?: Id<"projects">;
  stageId?: Id<"stages">;
}

export interface ScopedPolicy extends DashboardScope {
  document: PolicyDocument;
}

export interface MemberAccess {
  tier: OrgRole;
  policies: readonly ScopedPolicy[];
}

export function tierPermissions(tier: OrgRole): DashboardPolicyAction[] {
  return tier === "member" ? [] : [...DASHBOARD_POLICY_ACTIONS];
}

export function policiesAllow(
  policies: readonly ScopedPolicy[],
  action: string,
  scope: DashboardScope = {},
): boolean {
  return ruleVerdict(policies, action, scope) === "allow";
}

export function dashboardPermissions(
  access: MemberAccess,
  scope: DashboardScope = {},
): DashboardPolicyAction[] {
  return DASHBOARD_POLICY_ACTIONS.filter((action) =>
    policiesAllowOrTier(access, action, scope),
  );
}

export async function memberAccess(
  ctx: Ctx,
  orgId: Id<"orgs">,
  user: Doc<"users">,
): Promise<MemberAccess | null> {
  const org = await ctx.db.get(orgId);
  if (!org) return null;
  if (org.ownerAuthId === user.authId) return { tier: "owner", policies: [] };
  const membership = await getOrgMembership(ctx, orgId, user._id);
  if (!membership) return null;
  const role = membership.roleId ? await ctx.db.get(membership.roleId) : null;

  return {
    tier: membership.role,
    policies: role ? await activePolicies(ctx, role.policyIds) : [],
  };
}

export async function hasDashboardPermission(
  ctx: Ctx,
  orgId: Id<"orgs">,
  user: Doc<"users">,
  action: DashboardPolicyAction,
  scope: DashboardScope = {},
): Promise<boolean> {
  const access = await memberAccess(ctx, orgId, user);

  return access !== null && policiesAllowOrTier(access, action, scope);
}

export async function requireDashboardPermission(
  ctx: Ctx,
  orgId: Id<"orgs">,
  user: Doc<"users">,
  action: DashboardPolicyAction,
  scope: DashboardScope = {},
): Promise<void> {
  if (!(await hasDashboardPermission(ctx, orgId, user, action, scope))) {
    throw new ClientError("No permission for this", "unauthorized");
  }
}

// No grant beyond the caller's reach, or `access:write` / `members:write` is a way up.
// `before` is what the policies granted until now: an edit answers only for what it adds.
export async function assertGrantsWithinReach(
  ctx: Ctx,
  orgId: Id<"orgs">,
  caller: Doc<"users">,
  policies: readonly ScopedPolicy[],
  before: readonly ScopedPolicy[] = [],
): Promise<void> {
  const access = await memberAccess(ctx, orgId, caller);
  if (!access) throw new ClientError("No permission for this", "unauthorized");
  // The caller's own scoped denies mark where an org-wide grant would hand over what they lack.
  for (const scope of await scopesNamed(ctx, [
    ...policies,
    ...before,
    ...access.policies,
  ])) {
    const held = [
      ...dashboardPermissions(access, scope),
      ...dashboardPermissions({ tier: "member", policies: before }, scope),
    ];
    const beyond = dashboardPermissions(
      { tier: "member", policies: policies },
      scope,
    ).filter((permission) => !held.includes(permission));
    if (beyond.length > 0) {
      throw new ClientError(
        `That grants ${beyond.join(", ")}, which you do not hold`,
      );
    }
  }
}

export async function roleHoldingPolicy(
  ctx: Ctx,
  policy: Doc<"agentPolicies">,
): Promise<Doc<"orgRoles"> | null> {
  const account = await ctx.db.get(policy.accountId);
  const orgId = account ? orgIdOf(ctx, account) : null;
  if (!orgId) return null;
  const roles = await orgRoles(ctx, orgId);

  return roles.find((role) => role.policyIds.includes(policy._id)) ?? null;
}

export async function orgRoles(
  ctx: Ctx,
  orgId: Id<"orgs">,
): Promise<Doc<"orgRoles">[]> {
  return await ctx.db
    .query("orgRoles")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();
}

export async function activePolicies(
  ctx: Ctx,
  policyIds: readonly Id<"agentPolicies">[],
): Promise<ScopedPolicy[]> {
  const policies = await Promise.all(policyIds.map((id) => ctx.db.get(id)));

  return policies
    .filter((policy) => policy !== null)
    .filter((policy) => policy.status === "active")
    .map((policy) => ({
      document: policy.document,
      projectId: policy.projectId,
      stageId: policy.stageId,
    }));
}

export function policiesAllowOrTier(
  access: MemberAccess,
  action: DashboardPolicyAction,
  scope: DashboardScope,
): boolean {
  if (tierPermissions(access.tier).includes(action)) return true;
  const verdict = ruleVerdict(access.policies, action, scope);
  if (verdict) return verdict === "allow";

  // With no rule on `keys:read`, a granted `keys:write` reads too: a writer sees the list.
  return (
    action === "keys:read" &&
    policiesAllow(access.policies, "keys:write", scope)
  );
}

// A stage scope carries its project, as the stage's own checks evaluate it.
async function scopesNamed(
  ctx: Ctx,
  policies: readonly ScopedPolicy[],
): Promise<DashboardScope[]> {
  const scopes = new Map<string, DashboardScope>([["", {}]]);
  for (const policy of policies) {
    for (const rule of policy.document.rules) {
      const stageId =
        policy.stageId ?? idCondition(ctx, rule, "stage.id", "stages");
      const stage = stageId ? await ctx.db.get(stageId) : null;
      const scope: DashboardScope = {
        projectId:
          policy.projectId ??
          idCondition(ctx, rule, "project.id", "projects") ??
          stage?.projectId,
        stageId: stageId,
      };
      scopes.set(`${scope.projectId ?? ""}:${scope.stageId ?? ""}`, scope);
    }
  }

  return [...scopes.values()];
}

function idCondition<T extends "projects" | "stages">(
  ctx: Ctx,
  rule: PolicyRule,
  attribute: string,
  table: T,
): Id<T> | undefined {
  const match = (rule.conditions ?? []).find(
    (condition) =>
      condition.attribute === attribute && condition.operator === "equals",
  );

  return typeof match?.value === "string"
    ? (ctx.db.normalizeId(table, match.value) ?? undefined)
    : undefined;
}

function ruleVerdict(
  policies: readonly ScopedPolicy[],
  action: string,
  scope: DashboardScope,
): PolicyEffect | null {
  let verdict: PolicyEffect | null = null;
  for (const policy of policies) {
    if (policy.document.mode !== "enforce" || !scopeHolds(policy, scope)) {
      continue;
    }
    for (const rule of policy.document.rules) {
      if (!rule.actions.includes(action) || !ruleApplies(rule, scope)) continue;
      if (rule.effect === "deny") return "deny";
      verdict = "allow";
    }
  }

  return verdict;
}

function scopeHolds(policy: DashboardScope, scope: DashboardScope): boolean {
  return (
    (!policy.projectId || policy.projectId === scope.projectId) &&
    (!policy.stageId || policy.stageId === scope.stageId)
  );
}

// Any other condition names an attribute the dashboard has no value for: the rule never applies.
function ruleApplies(rule: PolicyRule, scope: DashboardScope): boolean {
  return (rule.conditions ?? []).every((condition) => {
    if (condition.operator !== "equals") return false;
    if (condition.attribute === "project.id") {
      return condition.value === scope.projectId;
    }
    if (condition.attribute === "stage.id") {
      return condition.value === scope.stageId;
    }

    return false;
  });
}
