/**
 * Resolves which account-plane objects belong to a project.
 *
 * `agents` rows are account-scoped and carry no projectId — the only link
 * between the account plane and the project plane is `agentConfigs.projectId`,
 * written by the canvas or by the API back-sync. Crons and conversations have
 * no projectId either; they point at an agent, so their project is whatever
 * their agent's is. Deriving that here, rather than storing a copy on each
 * table, is what makes it impossible for a cron to claim a different project
 * than the agent it actually runs.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;

/**
 * The agents belonging to `projectId`, across every environment.
 *
 * Agents with no `agentConfigs` row belong to no project and are absent —
 * that is the state of agents created while their account had no org (see
 * `agents.backfillCanvasLinks`).
 */
export async function agentsInProject(
    ctx: Ctx,
    projectId: Id<"projects">,
): Promise<Doc<"agents">[]> {
    // Prefix scan on the compound index: every environment of this project.
    const configs = await ctx.db
        .query("agentConfigs")
        .withIndex("by_projectId_and_environmentId", (q) => q.eq("projectId", projectId))
        .collect();

    const agents: Doc<"agents">[] = [];
    for (const config of configs) {
        if (!config.agentId) continue;
        // agentConfigs.agentId is a loose v.string(), so it can hold a stale or
        // malformed id that no longer resolves.
        const normalized = ctx.db.normalizeId("agents", config.agentId);
        if (!normalized) continue;
        const agent = await ctx.db.get(normalized);
        if (agent) agents.push(agent);
    }

    return agents;
}

/** The crons whose agent belongs to `projectId`. */
export async function cronsInProject(
    ctx: Ctx,
    projectId: Id<"projects">,
    accountId: Id<"accounts">,
): Promise<Doc<"crons">[]> {
    const agentIds = new Set((await agentsInProject(ctx, projectId)).map((agent) => agent._id));

    const crons = await ctx.db
        .query("crons")
        .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
        .collect();

    return crons.filter((cron) => agentIds.has(cron.agentId));
}
