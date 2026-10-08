/**
 * What a member may see and do in the dashboard. Owners and admins hold every
 * dashboard permission by tier. A member holds none until a custom role
 * grants some: the role's policies are the same documents core's OPA
 * evaluates for agents, read here with the same order (a deny wins, then an
 * allow, then nothing). A policy or a rule scoped to a project or a stage
 * counts only there, and only an enforce-mode policy counts at all.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { getOrgMembership, type OrgRole } from "./ownership/org";
import {
  DASHBOARD_POLICY_ACTIONS,
  type DashboardPolicyAction,
  type PolicyDocument,
  type PolicyRule,
} from "./policyRules";

type Ctx = QueryCtx | MutationCtx;

/** Where an action happens; a rule on a project or stage counts only there. */
export interface DashboardScope {
  projectId?: Id<"projects">;
  stageId?: Id<"stages">;
}

/** A policy as the evaluator reads it: its document, and the project or stage the row belongs to. */
export interface ScopedPolicy extends DashboardScope {
  document: PolicyDocument;
}

/** A member's tier in the org and the policies their role grants. */
export interface MemberAccess {
  tier: OrgRole;
  policies: ScopedPolicy[];
}

/** The permissions a tier holds before any role: admins everything, members nothing gated. */
export function tierPermissions(tier: OrgRole): DashboardPolicyAction[] {
  return tier === "member" ? [] : [...DASHBOARD_POLICY_ACTIONS];
}

/** Whether the enforce-mode policies allow one action in one scope: a matching deny wins, else a matching allow. */
export function policiesAllow(
  policies: readonly ScopedPolicy[],
  action: string,
  scope: DashboardScope = {},
): boolean {
  let allowed = false;
  for (const policy of policies) {
    if (policy.document.mode !== "enforce" || !scopeHolds(policy, scope)) {
      continue;
    }
    for (const rule of policy.document.rules) {
      if (!rule.actions.includes(action) || !ruleApplies(rule, scope)) continue;
      if (rule.effect === "deny") return false;
      allowed = true;
    }
  }

  return allowed;
}

/** The tier's permissions plus what the policies allow in the scope. */
export function dashboardPermissions(
  access: MemberAccess,
  scope: DashboardScope = {},
): DashboardPolicyAction[] {
  const held = new Set(tierPermissions(access.tier));
  for (const action of DASHBOARD_POLICY_ACTIONS) {
    if (policiesAllow(access.policies, action, scope)) held.add(action);
  }

  return [...held];
}

/** One member's tier and policies in one org; null when they are not a member. */
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

/** Throws the error the dashboard shows when the member may not do this. */
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

/** The policies that still exist and are active, with the scope their row carries. */
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

function policiesAllowOrTier(
  access: MemberAccess,
  action: DashboardPolicyAction,
  scope: DashboardScope,
): boolean {
  return (
    tierPermissions(access.tier).includes(action) ||
    policiesAllow(access.policies, action, scope)
  );
}

/** A policy row made for one project or stage applies only there. */
function scopeHolds(policy: DashboardScope, scope: DashboardScope): boolean {
  return (
    (!policy.projectId || policy.projectId === scope.projectId) &&
    (!policy.stageId || policy.stageId === scope.stageId)
  );
}

/**
 * A rule with no conditions applies everywhere; `project.id` and `stage.id`
 * equals-conditions pin it to that scope. Any other condition names an
 * attribute the dashboard has no value for, so the rule does not apply here.
 */
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
