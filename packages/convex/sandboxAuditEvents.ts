/**
 * Sandbox lifecycle audit events. Core writes these through the internal
 * mutation after provider lifecycle calls; the dashboard reads the active org's
 * recent events for one reservation key.
 */

import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { getActiveAccountForUser } from "./org";
import { sandboxAuditEventsFields } from "./schema";

const sandboxAuditEventDoc = v.object({
  ...sandboxAuditEventsFields,
  _id: v.id("sandboxAuditEvents"),
  _creationTime: v.number(),
});

/** Lists recent audit events for one sandbox instance in the active org. */
export const listForInstance = query({
  args: {
    reservationKey: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(sandboxAuditEventDoc),
  handler: async (ctx, args) => {
    const account = await getActiveAccountForUser(ctx);
    if (!account) return [];
    const limit = Math.max(1, Math.min(args.limit ?? 20, 50));

    return await ctx.db
      .query("sandboxAuditEvents")
      .withIndex("by_accountId_and_reservationKey_and_createdAt", (q) =>
        q
          .eq("accountId", account._id)
          .eq("reservationKey", args.reservationKey),
      )
      .order("desc")
      .take(limit);
  },
});

/** Inserts one sandbox lifecycle audit row, enriching it from the instance row. */
export const insert = internalMutation({
  args: {
    accountId: v.id("accounts"),
    sandboxConfigId: v.optional(v.id("sandboxConfigs")),
    reservationKey: v.string(),
    provider: sandboxAuditEventsFields.provider,
    action: sandboxAuditEventsFields.action,
    result: sandboxAuditEventsFields.result,
    status: sandboxAuditEventsFields.status,
    actorSource: sandboxAuditEventsFields.actorSource,
    actorId: sandboxAuditEventsFields.actorId,
    actorEmail: sandboxAuditEventsFields.actorEmail,
    actorName: sandboxAuditEventsFields.actorName,
    traceId: sandboxAuditEventsFields.traceId,
    taskId: sandboxAuditEventsFields.taskId,
    errorMessage: sandboxAuditEventsFields.errorMessage,
    exitCode: sandboxAuditEventsFields.exitCode,
    durationMs: sandboxAuditEventsFields.durationMs,
    truncated: sandboxAuditEventsFields.truncated,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const instance = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (instance && instance.accountId !== args.accountId) return null;
    const sandboxConfigId = args.sandboxConfigId ?? instance?.sandboxConfigId;
    const status = args.status ?? instance?.status;
    const traceId = args.traceId ?? instance?.lastUsedTraceId;
    const taskId = args.taskId ?? instance?.lastUsedTaskId;

    await ctx.db.insert("sandboxAuditEvents", {
      accountId: args.accountId,
      ...(instance?.projectId ? { projectId: instance.projectId } : {}),
      ...(instance?.environmentId
        ? { environmentId: instance.environmentId }
        : {}),
      ...(sandboxConfigId ? { sandboxConfigId } : {}),
      reservationKey: args.reservationKey,
      provider: args.provider,
      action: args.action,
      result: args.result,
      ...(status ? { status } : {}),
      actorSource: args.actorSource,
      ...(args.actorId ? { actorId: args.actorId } : {}),
      ...(args.actorEmail ? { actorEmail: args.actorEmail } : {}),
      ...(args.actorName ? { actorName: args.actorName } : {}),
      ...(traceId ? { traceId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
      ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
      ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
      ...(args.truncated !== undefined ? { truncated: args.truncated } : {}),
      createdAt: Date.now(),
    });

    return null;
  },
});
