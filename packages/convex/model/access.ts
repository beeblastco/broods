/**
 * What a member may see and do in the dashboard. Owners and admins hold every
 * dashboard permission by tier. A member holds none until a custom role
 * grants some: the role's policies are the same documents core's OPA
 * evaluates for agents, read here with the same order (a deny wins, then an
 * allow, then nothing). A rule scoped to a project or a stage counts only
 * there, and only an enforce-mode policy counts at all.
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

/** A member's tier in the org and the policy documents their role grants. */
export interface MemberAccess {
  tier: OrgRole;
  policies: PolicyDocument[];
}

/** The permissions a tier holds before any role: admins everything, members nothing gated. */
export function tierPermissions(tier: OrgRole): DashboardPolicyAction[] {
  return tier === "member" ? [] : [...DASHBOARD_POLICY_ACTIONS];
}

/** Whether the enforce-mode policies allow one action in one scope: a matching deny wins, else a matching allow. */
export function policiesAllow(
  policies: readonly PolicyDocument[],
  action: string,
  scope: DashboardScope = {},
): boolean {
  let allowed = false;
  for (const policy of policies) {
    if (policy.mode !== "enforce") continue;
    for (const rule of policy.rules) {
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
    policies: role ? await activePolicyDocuments(ctx, role.policyIds) : [],
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

/** The documents of the policies that still exist and are active. */
export async function activePolicyDocuments(
  ctx: Ctx,
  policyIds: readonly Id<"agentPolicies">[],
): Promise<PolicyDocument[]> {
  const policies = await Promise.all(policyIds.map((id) => ctx.db.get(id)));

  return policies
    .filter((policy) => policy !== null)
    .filter((policy) => policy.status === "active")
    .map((policy) => policy.document);
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
