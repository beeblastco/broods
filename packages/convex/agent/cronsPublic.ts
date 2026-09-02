/**
 * Public mutation wrappers for cron CRUD used by the dashboard. These run the
 * transactional cron mutations in agent/crons in the same transaction, so the
 * crons table and the registered schedules can never drift apart.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";
import { getActiveAccountForUser } from "../org/orgs";

const STATUS_VALIDATOR = v.union(v.literal("active"), v.literal("paused"));
// A cron runs stored instructions as any agent of the org, on a schedule, and
// can answer into a live channel session: that is an org admin operation.
const CRON_ADMIN_REQUIRED =
  "Scheduled jobs can only be changed by an org admin.";

/** Creates a cron job (crons row + registered schedule) for the active org. */
export const create = mutation({
  args: {
    name: v.string(),
    agentId: v.id("agents"),
    input: v.string(),
    conversationKey: v.optional(v.string()),
    scheduleExpression: v.string(),
    timezone: v.optional(v.string()),
    status: STATUS_VALIDATOR,
    description: v.optional(v.string()),
  },
  returns: v.object({ cronId: v.string() }),
  handler: async (ctx, args) => {
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CRON_ADMIN_REQUIRED);

    const cron = (await ctx.runMutation(internal.agent.crons.create, {
      accountId: account._id,
      input: args,
    })) as { cronId: string };

    return { cronId: cron.cronId };
  },
});

/** Updates a cron job and its registered schedule for the active org. */
export const update = mutation({
  args: {
    cronId: v.string(),
    name: v.optional(v.string()),
    agentId: v.optional(v.id("agents")),
    input: v.optional(v.string()),
    conversationKey: v.optional(v.string()),
    scheduleExpression: v.optional(v.string()),
    timezone: v.optional(v.string()),
    status: v.optional(STATUS_VALIDATOR),
    description: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { cronId, ...patch } = args;
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CRON_ADMIN_REQUIRED);

    const updated = await ctx.runMutation(internal.agent.crons.update, {
      accountId: account._id,
      cronId: cronId,
      patch: patch,
    });
    if (!updated) throw new Error("Cron job not found");

    return null;
  },
});

/** Removes a cron job and its registered schedule for the active org. */
export const remove = mutation({
  args: { cronId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CRON_ADMIN_REQUIRED);

    const removed = await ctx.runMutation(internal.agent.crons.remove, {
      accountId: account._id,
      cronId: args.cronId,
    });
    if (!removed) throw new Error("Cron job not found");

    return null;
  },
});
