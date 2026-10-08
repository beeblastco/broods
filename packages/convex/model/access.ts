/**
 * What a member may see and do in the dashboard. Owners and admins hold every
 * dashboard permission by tier. A member holds none until a custom role
 * grants some: the role's policies are the same documents core's OPA
 * evaluates for agents, read here with the same order (a deny wins, then an
 * allow, then nothing).
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgMembership, type OrgRole } from "./ownership/org";
import {
  DASHBOARD_POLICY_ACTIONS,
  type DashboardPolicyAction,
  type PolicyDocument,
} from "./policyRules";

type Ctx = QueryCtx | MutationCtx;

/** The permissions a tier holds before any role: admins everything, members nothing gated. */
export function tierPermissions(tier: OrgRole): DashboardPolicyAction[] {
  return tier === "member" ? [] : [...DASHBOARD_POLICY_ACTIONS];
}

/** Whether the policies allow one action: a matching deny wins, else a matching allow. */
export function policiesAllow(
  policies: readonly PolicyDocument[],
  action: string,
): boolean {
  let allowed = false;
  for (const policy of policies) {
    for (const rule of policy.rules) {
      if (!rule.actions.includes(action)) continue;
      if (rule.effect === "deny") return false;
      allowed = true;
    }
  }

  return allowed;
}

/** The tier's permissions plus what the role's policies allow on top. */
export function dashboardPermissions(
  tier: OrgRole,
  policies: readonly PolicyDocument[],
): DashboardPolicyAction[] {
  const held = new Set(tierPermissions(tier));
  for (const action of DASHBOARD_POLICY_ACTIONS) {
    if (policiesAllow(policies, action)) held.add(action);
  }

  return [...held];
}

/** The dashboard permissions one member holds in one org. */
export async function viewerDashboardPermissions(
  ctx: Ctx,
  orgId: Id<"orgs">,
  user: Doc<"users">,
): Promise<DashboardPolicyAction[]> {
  const org = await ctx.db.get(orgId);
  if (!org) return [];
  if (org.ownerAuthId === user.authId) return tierPermissions("owner");
  const membership = await getOrgMembership(ctx, orgId, user._id);
  if (!membership) return [];
  const role = membership.roleId ? await ctx.db.get(membership.roleId) : null;
  const policies = role ? await activePolicyDocuments(ctx, role.policyIds) : [];

  return dashboardPermissions(membership.role, policies);
}

export async function hasDashboardPermission(
  ctx: Ctx,
  orgId: Id<"orgs">,
  user: Doc<"users">,
  action: DashboardPolicyAction,
): Promise<boolean> {
  const held = await viewerDashboardPermissions(ctx, orgId, user);

  return held.includes(action);
}

/** The documents of the policies that still exist and are active. */
export async function activePolicyDocuments(
  ctx: Ctx,
  policyIds: readonly Id<"agentPolicies">[],
): Promise<PolicyDocument[]> {
  const documents: PolicyDocument[] = [];
  for (const policyId of policyIds) {
    const policy = await ctx.db.get(policyId);
    if (policy && policy.status === "active") {
      documents.push(policy.document as PolicyDocument);
    }
  }

  return documents;
}
