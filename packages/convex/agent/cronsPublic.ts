/**
 * Public action wrappers for cron CRUD used by the dashboard. These call the
 * transactional cron mutations in agent/crons directly, so the crons table
 * and the registered schedules can never drift apart.
 */

import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { action } from "../_generated/server";

const STATUS_VALIDATOR = v.union(v.literal("active"), v.literal("paused"));

/** Creates a cron job (crons row + registered schedule) for the active org. */
export const create = action({
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
    const account = await ctx.runQuery(api.org.orgs.getActiveAccount, {});
    if (!account) throw new Error("No active org / account not provisioned");

    const cron = (await ctx.runMutation(internal.agent.crons.create, {
      accountId: account.accountId,
      input: args,
    })) as { cronId: string };

    return { cronId: cron.cronId };
  },
});

/** Updates a cron job and its registered schedule for the active org. */
export const update = action({
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
    const account = await ctx.runQuery(api.org.orgs.getActiveAccount, {});
    if (!account) throw new Error("No active org / account not provisioned");

    const updated = await ctx.runMutation(internal.agent.crons.update, {
      accountId: account.accountId,
      cronId: cronId,
      patch: patch,
    });
    if (!updated) throw new Error("Cron job not found");

    return null;
  },
});

/** Removes a cron job and its registered schedule for the active org. */
export const remove = action({
  args: { cronId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await ctx.runQuery(api.org.orgs.getActiveAccount, {});
    if (!account) throw new Error("No active org / account not provisioned");

    const removed = await ctx.runMutation(internal.agent.crons.remove, {
      accountId: account.accountId,
      cronId: args.cronId,
    });
    if (!removed) throw new Error("Cron job not found");

    return null;
  },
});
