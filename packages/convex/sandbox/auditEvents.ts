/**
 * Sandbox lifecycle audit events. Core writes these through the internal
 * mutation after provider lifecycle calls; the dashboard reads the active org's
 * recent events for one reservation key.
 */

import type { WithoutSystemFields } from "convex/server";
import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import {
  internalMutation,
  type MutationCtx,
  query,
} from "../_generated/server";
import { getActiveAccountForUser } from "../org/orgs";
import { sandboxAuditEventsFields } from "../schema";

/** A registry row as inserted or as read back; the audit needs no system fields. */
type SandboxInstanceRow = WithoutSystemFields<Doc<"sandboxInstances">>;

const sandboxAuditEventDoc = v.object({
  ...sandboxAuditEventsFields,
  _id: v.id("sandboxAuditEvents"),
  _creationTime: v.number(),
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
  handler: async (ctx, args): Promise<null> => {
    const instance = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (instance && instance.accountId !== args.accountId) return null;

    await ctx.db.insert("sandboxAuditEvents", {
      ...auditEventHeadFields(args, instance),
      ...auditEventTailFields(args, instance),
      createdAt: Date.now(),
    });

    return null;
  },
});

/** Lists recent audit events for one sandbox instance in the active org. */
export const listForInstance = query({
  args: {
    reservationKey: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.array(sandboxAuditEventDoc),
  handler: async (ctx, args): Promise<Doc<"sandboxAuditEvents">[]> => {
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

/**
 * The audit row for a lifecycle step the runtime took on its own while
 * mirroring an instance: `reserve` when the registry row is inserted or a
 * replacement machine takes over its key, `resume` when a reconnect brings a
 * suspended machine back. Written in the same transaction as the registry
 * write, so a reconnect can never find the instance without it. Skipped for
 * ephemeral instances: one row per bash call would drown the sandbox's own
 * history.
 */
export async function recordRuntimeAction(
  ctx: MutationCtx,
  instance: SandboxInstanceRow,
  action: "reserve" | "resume",
): Promise<void> {
  if (instance.ephemeral) return;

  await ctx.db.insert("sandboxAuditEvents", {
    ...auditEventHeadFields(
      {
        accountId: instance.accountId,
        reservationKey: instance.reservationKey,
        provider: instance.provider,
        action: action,
        result: "ok",
      },
      instance,
    ),
    ...auditEventTailFields(
      {
        actorSource: instance.agentId ? "agent" : "service",
        actorId: instance.agentId,
        ...(action === "reserve"
          ? {
              traceId: instance.createdByTraceId,
              taskId: instance.createdByTaskId,
            }
          : {}),
      },
      instance,
    ),
    createdAt: Date.now(),
  });
}

/** Audit-row identity/outcome columns, enriched from the instance row when the caller omitted them. */
function auditEventHeadFields(
  args: Pick<
    Doc<"sandboxAuditEvents">,
    "accountId" | "reservationKey" | "provider" | "action" | "result"
  > &
    Partial<Pick<Doc<"sandboxAuditEvents">, "sandboxConfigId" | "status">>,
  instance: SandboxInstanceRow | null,
): Partial<
  Pick<
    Doc<"sandboxAuditEvents">,
    "projectId" | "stageId" | "sandboxConfigId" | "status"
  >
> &
  Pick<
    Doc<"sandboxAuditEvents">,
    "accountId" | "reservationKey" | "provider" | "action" | "result"
  > {
  const sandboxConfigId = args.sandboxConfigId ?? instance?.sandboxConfigId;
  const status = args.status ?? instance?.status;

  return {
    accountId: args.accountId,
    ...(instance?.projectId ? { projectId: instance.projectId } : {}),
    ...(instance?.stageId ? { stageId: instance.stageId } : {}),
    ...(sandboxConfigId ? { sandboxConfigId: sandboxConfigId } : {}),
    reservationKey: args.reservationKey,
    provider: args.provider,
    action: args.action,
    result: args.result,
    ...(status ? { status: status } : {}),
  };
}

/** Actor/trace/metric columns; trace and task ids fall back to the instance's last-used ones. */
function auditEventTailFields(
  args: Pick<Doc<"sandboxAuditEvents">, "actorSource"> &
    Partial<
      Pick<
        Doc<"sandboxAuditEvents">,
        | "actorId"
        | "actorEmail"
        | "actorName"
        | "traceId"
        | "taskId"
        | "errorMessage"
        | "exitCode"
        | "durationMs"
        | "truncated"
      >
    >,
  instance: SandboxInstanceRow | null,
): Pick<Doc<"sandboxAuditEvents">, "actorSource"> &
  Partial<
    Pick<
      Doc<"sandboxAuditEvents">,
      | "actorId"
      | "actorEmail"
      | "actorName"
      | "traceId"
      | "taskId"
      | "errorMessage"
      | "exitCode"
      | "durationMs"
      | "truncated"
    >
  > {
  const traceId = args.traceId ?? instance?.lastUsedTraceId;
  const taskId = args.taskId ?? instance?.lastUsedTaskId;

  return {
    actorSource: args.actorSource,
    ...(args.actorId ? { actorId: args.actorId } : {}),
    ...(args.actorEmail ? { actorEmail: args.actorEmail } : {}),
    ...(args.actorName ? { actorName: args.actorName } : {}),
    ...(traceId ? { traceId: traceId } : {}),
    ...(taskId ? { taskId: taskId } : {}),
    ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
    ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
    ...(args.truncated !== undefined ? { truncated: args.truncated } : {}),
  };
}
