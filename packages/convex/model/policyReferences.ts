/**
 * The rule for removing an agent policy. A policy only ever refuses, so a
 * reference to a deleted one must not vanish quietly: core refuses everything
 * for it, and the config plane refuses the delete while it is still attached.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ClientError } from "./clientError";
import { orgRoles } from "./access";

/** Opens the guard's refusal, so the HTTP layer can answer 409 on it. */
export const POLICY_STILL_REFERENCED = "Policy still referenced:";

/** Every row that can list a policy of one account. */
export interface PolicyReferenceRows {
  agents: Doc<"agentConfigs">[];
  records: Doc<"channelRecords">[];
  roles: Doc<"orgRoles">[];
}

/**
 * Refuses to remove a policy an agent or a channel record still lists in
 * `policies`, or an org role holds: dropping a role's deny would widen it. Pass `rows` when checking several policies of one account.
 * @throws naming the resources that still reference it.
 */
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

/**
 * An agent may list any active policy of its account, whatever stage either
 * sits in, so the scan covers every project of the account's org.
 * `agentConfigs` has no account index; projects are the way in.
 */
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

// Both blobs are `v.any()` columns, so only the one key read here is named.
function listsPolicy(
  config: { policies?: unknown } | undefined,
  policyId: Id<"agentPolicies">,
): boolean {
  return Array.isArray(config?.policies) && config.policies.includes(policyId);
}
