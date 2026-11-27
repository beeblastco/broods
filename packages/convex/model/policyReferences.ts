import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { orgRoles } from "./access";

export const POLICY_STILL_REFERENCED = "Policy still referenced:";

export interface PolicyReferenceRows {
  agents: Doc<"agentConfigs">[];
  records: Doc<"channelRecords">[];
  roles: Doc<"orgRoles">[];
}

// A deleted policy still listed makes core refuse everything; a dropped role deny widens it.
export async function assertPolicyUnreferenced(
  ctx: QueryCtx | MutationCtx,
  policy: Doc<"agentPolicies">,
  rows?: PolicyReferenceRows,
): Promise<void> {
  const { agents, records, roles } =
    rows ?? (await loadPolicyReferenceRows(ctx, policy.accountId));
  const referencing = [
    ...agents
      .filter((entry) => listsPolicy(entry.extraConfig, policy._id))
      .map((entry) => `agent "${entry.name}"`),
    ...records
      .filter((entry) => listsPolicy(entry.config, policy._id))
      .map((entry) => `channel record "${entry.name}"`),
    ...roles
      .filter((entry) => entry.policyIds.includes(policy._id))
      .map((entry) => `role "${entry.name}"`),
  ].sort();
  if (referencing.length === 0) return;

  throw new ClientError(
    `${POLICY_STILL_REFERENCED} ${referencing.join(", ")} list "${policy.name}". ` +
      "Detach it from those resources before deleting it.",
    "conflict",
  );
}

// A policy may be listed from any stage, and agentConfigs has no account index: scan projects.
export async function loadPolicyReferenceRows(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
): Promise<PolicyReferenceRows> {
  const account = await ctx.db.get(accountId);
  const orgId = account ? ctx.db.normalizeId("orgs", account.orgId) : null;
  const projects = orgId
    ? await ctx.db
        .query("projects")
        .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
        .collect()
    : [];
  const agents = await Promise.all(
    projects.map(
      async (project): Promise<Doc<"agentConfigs">[]> =>
        await ctx.db
          .query("agentConfigs")
          .withIndex("by_projectId_and_stageId", (q) =>
            q.eq("projectId", project._id),
          )
          .collect(),
    ),
  );
  const records = await ctx.db
    .query("channelRecords")
    .withIndex("by_accountId_and_status", (q) =>
      q.eq("accountId", accountId).eq("status", "active"),
    )
    .collect();

  const roles = orgId ? await orgRoles(ctx, orgId) : [];

  return { agents: agents.flat(), records: records, roles: roles };
}

function listsPolicy(
  config: { policies?: unknown } | undefined,
  policyId: Id<"agentPolicies">,
): boolean {
  return Array.isArray(config?.policies) && config.policies.includes(policyId);
}
