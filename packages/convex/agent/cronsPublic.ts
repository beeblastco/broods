import { v } from "convex/values";
import { internal } from "../_generated/api";
import { mutation } from "../_generated/server";
import { requireActiveAccount } from "../model/activeAccount";
import { getActiveAccountForUser, getActiveCaller } from "../org/orgs";

const STATUS_VALIDATOR = v.union(v.literal("active"), v.literal("paused"));
// Runs stored instructions as any org agent, into live channels: an org admin operation.
const CRON_ADMIN_REQUIRED =
  "Scheduled jobs can only be changed by an org admin.";

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
  handler: async (ctx, args): Promise<{ cronId: string }> => {
    const caller = await getActiveCaller(ctx, "admin");
    if (!caller) throw new Error(CRON_ADMIN_REQUIRED);
    await requireActiveAccount(ctx, caller.account._id);

    const cron = (await ctx.runMutation(internal.agent.crons.create, {
      accountId: caller.account._id,
      input: args,
      createdBy: caller.user._id,
    })) as { cronId: string };

    return { cronId: cron.cronId };
  },
});

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
  handler: async (ctx, args): Promise<null> => {
    const { cronId, ...patch } = args;
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CRON_ADMIN_REQUIRED);
    await requireActiveAccount(ctx, account._id);

    const updated = await ctx.runMutation(internal.agent.crons.update, {
      accountId: account._id,
      cronId: cronId,
      patch: patch,
    });
    if (!updated) throw new Error("Cron job not found");

    return null;
  },
});

export const remove = mutation({
  args: { cronId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const account = await getActiveAccountForUser(ctx, "admin");
    if (!account) throw new Error(CRON_ADMIN_REQUIRED);
    await requireActiveAccount(ctx, account._id);

    const removed = await ctx.runMutation(internal.agent.crons.remove, {
      accountId: account._id,
      cronId: args.cronId,
    });
    if (!removed) throw new Error("Cron job not found");

    return null;
  },
});
