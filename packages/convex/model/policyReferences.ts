/**
 * The rule for removing an agent policy. A policy only ever refuses, so a
 * reference to a deleted one must not vanish quietly: core refuses everything
 * for it, and the config plane refuses the delete while it is still attached.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { ChannelRecordConfig } from "./channelRules";

/**
 * Refuses to remove a policy an agent or a channel record still lists in
 * `policies`.
 * @throws naming the resources that still reference it.
 */
export async function assertPolicyUnreferenced(
  ctx: QueryCtx | MutationCtx,
  policy: Doc<"agentPolicies">,
): Promise<void> {
  const { projectId, stageId } = policy;
  const agents =
    projectId && stageId
      ? await ctx.db
          .query("agentConfigs")
          .withIndex("by_projectId_and_stageId", (q) =>
            q.eq("projectId", projectId).eq("stageId", stageId),
          )
          .collect()
      : [];
  const records = await ctx.db
    .query("channelRecords")
    .withIndex("by_accountId_and_status", (q) =>
      q.eq("accountId", policy.accountId).eq("status", "active"),
    )
    .collect();
  const referencing = [
    ...agents
      .filter((entry) => listsPolicy(entry.extraConfig, policy._id))
      .map((entry) => `agent "${entry.name}"`),
    ...records
      .filter((entry) => listsPolicy(entry.config, policy._id))
      .map((entry) => `channel record "${entry.name}"`),
  ].sort();
  if (referencing.length === 0) return;

  throw new Error(
    `Policy "${policy.name}" is still referenced by ${referencing.join(", ")}. ` +
      "Detach it from those resources before deleting it.",
  );
}

// Both blobs carry their policy ids the same way, as the `policies` list the
// config normalizers validated on write.
function listsPolicy(
  config: Pick<ChannelRecordConfig, "policies"> | undefined,
  policyId: Id<"agentPolicies">,
): boolean {
  return config?.policies?.includes(policyId) ?? false;
}
