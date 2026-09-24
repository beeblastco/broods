/**
 * Persistent-sandbox instance registry scoped to an account. Mirrors broods's
 * sandbox reconnection state so the SaaS dashboard can show live instances and
 * drive suspend/resume/terminate through Convex live queries. broods owns the
 * provider lifecycle and writes each transition here through the internal
 * mutations; the dashboard reads via `listForActiveOrg` and writes through
 * `sandboxPublic` actions that proxy back to broods.
 *
 * `upsert` is the create-time populate keyed by reservationKey (carrying the size
 * `specs`), called when broods reserves a persistent sandbox; `setStatus`/`remove`
 * mirror later transitions; `listForActiveOrg` is the dashboard read.
 *
 * Every write here also bills the running time since the last one onto the
 * account's usage meter (`model/usageMeter.ts`); `accrueRecent` does the same
 * hourly for sandboxes nothing wrote to.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "../_generated/server";
import {
  addUsage,
  SANDBOX_IDLE_BILL_MS,
  sandboxAccrual,
  sandboxLaunchUsage,
} from "../model/usageMeter";
import { getActiveAccountForUser } from "../org/orgs";
import { sandboxInstancesFields } from "../schema";
import { recordRuntimeAction } from "./auditEvents";

// Covers two missed hourly accruals before a sandbox's unbilled time is lost.
const ACCRUE_LOOKBACK_MS = 2 * 60 * 60 * 1000;
// Each instance also reads and writes its account's meter row; 100 keeps a
// page far under Convex's per-transaction read limits.
const ACCRUE_PAGE_SIZE = 100;

const sandboxInstanceDoc = v.object({
  ...sandboxInstancesFields,
  _id: v.id("sandboxInstances"),
  _creationTime: v.number(),
});

/**
 * Internal action helper: verifies a dashboard lifecycle request targets an
 * instance owned by the active account and created from the supplied sandbox row.
 */
export const isControllable = internalQuery({
  args: {
    accountId: v.id("accounts"),
    sandboxConfigId: v.id("sandboxConfigs"),
    reservationKey: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const instance = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .unique();

    return Boolean(
      instance &&
      instance.accountId === args.accountId &&
      instance.sandboxConfigId === args.sandboxConfigId,
    );
  },
});

/**
 * Internal list of mirrored sandbox instances for one account. Rows are
 * deleted on termination and live counts are bounded by the per-workspace
 * sandbox concurrency limits, so the 1000-row take is a generous ceiling,
 * not a pagination seam.
 * @param accountId the owning account
 * @returns the account's instance rows
 */
export const listForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(sandboxInstanceDoc),
  handler: async (ctx, args): Promise<Doc<"sandboxInstances">[]> => {
    return await ctx.db
      .query("sandboxInstances")
      .withIndex("by_accountId_projectId_and_stageId", (q) =>
        q.eq("accountId", args.accountId),
      )
      .take(1000);
  },
});

/**
 * Public query: lists persistent sandbox instances for the caller's active org.
 * Used by the dashboard Sandbox tab for live status.
 * @returns the account's instance rows, or `[]` when no org/account resolves.
 */
export const listForActiveOrg = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.array(sandboxInstanceDoc),
  handler: async (ctx, args): Promise<Doc<"sandboxInstances">[]> => {
    const account = await getActiveAccountForUser(ctx);
    if (!account) return [];

    return await ctx.db
      .query("sandboxInstances")
      .withIndex("by_accountId_projectId_and_stageId", (q) =>
        q
          .eq("accountId", account._id)
          .eq("projectId", args.projectId)
          .eq("stageId", args.stageId),
      )
      .take(100);
  },
});

/**
 * Drops an instance row when broods terminates the sandbox or releases the
 * reservation. No-op when the key is unknown, belongs to another account, or
 * (when `externalId` is given) has since been repointed at another machine.
 * @param accountId the owning account.
 * @param reservationKey the broods reconnection key.
 * @param externalId the provider id the caller tore down, when the row must still name it.
 */
export const remove = internalMutation({
  args: {
    accountId: v.id("accounts"),
    reservationKey: v.string(),
    externalId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (
    ctx,
    { accountId, reservationKey, externalId },
  ): Promise<null> => {
    const instance = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) =>
        q.eq("reservationKey", reservationKey),
      )
      .unique();
    if (
      instance &&
      instance.accountId === accountId &&
      (externalId === undefined || instance.externalId === externalId)
    ) {
      await accrue(ctx, instance, Date.now());
      await ctx.db.delete(instance._id);
    }

    return null;
  },
});

/**
 * Records a lifecycle transition (suspend/resume) for an instance, stamping the
 * matching timestamp. No-op when the key is unknown or belongs to another
 * account. Called by broods after the provider lifecycle call succeeds.
 * @param accountId the owning account.
 * @param reservationKey the broods reconnection key.
 * @param status the new lifecycle status.
 * @param errorMessage the provider's reason when `status` is `error`.
 */
export const setStatus = internalMutation({
  args: {
    accountId: v.id("accounts"),
    reservationKey: v.string(),
    status: sandboxInstancesFields.status,
    observed: v.optional(v.boolean()),
    errorMessage: sandboxInstancesFields.errorMessage,
  },
  returns: v.boolean(),
  handler: async (
    ctx,
    { accountId, reservationKey, status, observed, errorMessage },
  ): Promise<boolean> => {
    const instance = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) =>
        q.eq("reservationKey", reservationKey),
      )
      .unique();
    if (!instance || instance.accountId !== accountId) return false;

    const now = Date.now();
    await accrue(ctx, instance, now);
    if (instance.status === "suspended" && status === "running") {
      await addUsage(ctx, accountId, sandboxLaunchUsage(instance), now);
    }
    await ctx.db.patch(instance._id, {
      meteredUntil: now,
      status: status,
      // `undefined` unsets the field, so a reason never outlives its error.
      errorMessage: status === "error" ? errorMessage : undefined,
      // Only a use moves "last used". Stamping every transition let a suspend --
      // or a status read that merely observed one -- rewrite it to now, so a row
      // untouched for a day still read as seconds old.
      ...(status === "running" && !observed ? { lastUsedAt: now } : {}),
      ...(status === "suspended" ? { suspendedAt: now } : {}),
    });

    return instance.status !== status;
  },
});

/**
 * Create-or-refresh the registry row for a reserved sandbox, keyed by
 * reservationKey. Called by broods when it reserves a persistent instance so the
 * dashboard sees it live. Idempotent: refreshes the existing row (back to
 * `running`) on reconnect/re-reserve. No-op when the key belongs to another account.
 * Writes the `reserve` audit row on insert and when a replacement machine takes
 * over the key, and `resume` when a reconnect brings a suspended one back; a
 * plain reconnect adds nothing.
 * @param accountId the owning account.
 * @param provider the sandbox compute backend.
 * @param reservationKey the broods reconnection key (globally unique).
 * @param externalId the provider-side instance id.
 * @param name the display name (the sandbox config's name).
 * @param specs the instance's vcpu/memory/disk footprint.
 * @param sandboxConfigId the sandbox config row this instance was reserved from.
 * @param snapshotId the snapshot/image the instance launched from, when pinned.
 * @param logStream the provider-side guest log stream, known only at launch.
 * @param ephemeral marks a per-call instance the dashboard must not try to control.
 */
export const upsert = internalMutation({
  args: {
    accountId: v.id("accounts"),
    projectId: v.optional(v.id("projects")),
    stageId: v.optional(v.id("stages")),
    provider: sandboxInstancesFields.provider,
    reservationKey: v.string(),
    externalId: v.string(),
    name: v.string(),
    specs: sandboxInstancesFields.specs,
    sandboxConfigId: v.optional(v.id("sandboxConfigs")),
    snapshotId: v.optional(v.string()),
    egress: sandboxInstancesFields.egress,
    permissionMode: sandboxInstancesFields.permissionMode,
    createdByTraceId: sandboxInstancesFields.createdByTraceId,
    createdByTaskId: sandboxInstancesFields.createdByTaskId,
    lastUsedTraceId: sandboxInstancesFields.lastUsedTraceId,
    lastUsedTaskId: sandboxInstancesFields.lastUsedTaskId,
    agentId: sandboxInstancesFields.agentId,
    conversationKey: sandboxInstancesFields.conversationKey,
    workspaceName: sandboxInstancesFields.workspaceName,
    workspaceId: sandboxInstancesFields.workspaceId,
    logStream: sandboxInstancesFields.logStream,
    ephemeral: sandboxInstancesFields.ephemeral,
    ownCredentials: sandboxInstancesFields.ownCredentials,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const existing = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (existing && existing.accountId !== args.accountId) return null;

    const now = Date.now();
    const fields = upsertRefreshFields(args, now);
    if (existing) {
      // A new externalId under the same key is a replacement: the executor
      // found the old machine gone at the provider and launched another, so
      // this is a fresh reservation with its own creating trace.
      const replaced = existing.externalId !== args.externalId;
      await accrue(ctx, existing, now);
      // A new machine, a suspended one resumed, or one that idled past its
      // timeout (so the provider suspended it) loads its snapshot again.
      if (
        replaced ||
        existing.status === "suspended" ||
        now > existing.lastUsedAt + SANDBOX_IDLE_BILL_MS
      ) {
        await addUsage(ctx, args.accountId, sandboxLaunchUsage(args), now);
      }
      const patch = {
        ...fields,
        meteredUntil: now,
        ...(replaced || !existing.createdByTraceId
          ? { createdByTraceId: args.createdByTraceId }
          : {}),
        ...(replaced || !existing.createdByTaskId
          ? { createdByTaskId: args.createdByTaskId }
          : {}),
      };
      await ctx.db.patch(existing._id, patch);
      const action = replaced
        ? "reserve"
        : existing.status === "suspended"
          ? "resume"
          : null;
      if (action) {
        await recordRuntimeAction(ctx, { ...existing, ...patch }, action);
      }

      return null;
    }

    const row = {
      accountId: args.accountId,
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.stageId ? { stageId: args.stageId } : {}),
      provider: args.provider,
      reservationKey: args.reservationKey,
      createdAt: now,
      ...(args.createdByTraceId
        ? { createdByTraceId: args.createdByTraceId }
        : {}),
      ...(args.createdByTaskId
        ? { createdByTaskId: args.createdByTaskId }
        : {}),
      ...fields,
    };
    await ctx.db.insert("sandboxInstances", { ...row, meteredUntil: now });
    await addUsage(ctx, args.accountId, sandboxLaunchUsage(args), now);
    await recordRuntimeAction(ctx, row, "reserve");

    return null;
  },
});

/**
 * Bill the running time of every sandbox used recently enough to still have
 * some unbilled, so the meter stays current for one nothing writes to.
 * Hourly cron. One bounded page per transaction; the rest is scheduled with
 * the same `now`, so every page bills up to the same instant.
 */
export const accrueRecent = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = args.now ?? Date.now();
    const page = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_lastUsedAt", (q) =>
        q.gte("lastUsedAt", now - SANDBOX_IDLE_BILL_MS - ACCRUE_LOOKBACK_MS),
      )
      .paginate({ numItems: ACCRUE_PAGE_SIZE, cursor: args.cursor ?? null });
    for (const instance of page.page) {
      const meteredUntil = await accrue(ctx, instance, now);
      if (meteredUntil !== instance.meteredUntil) {
        await ctx.db.patch(instance._id, { meteredUntil: meteredUntil });
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.sandbox.instances.accrueRecent, {
        now: now,
        cursor: page.continueCursor,
      });
    }

    return null;
  },
});

// Add a sandbox's unbilled running time to its account's meter.
async function accrue(
  ctx: MutationCtx,
  instance: Doc<"sandboxInstances">,
  now: number,
): Promise<number> {
  const accrual = sandboxAccrual(instance, now);
  await addUsage(ctx, instance.accountId, accrual.usage, now);

  return accrual.meteredUntil;
}

/**
 * The refreshed registry columns `upsert` writes on both the patch and the
 * insert path: identity/size plus every optional column the caller supplied.
 */
function upsertRefreshFields(
  args: Pick<Doc<"sandboxInstances">, "externalId" | "name" | "specs"> &
    Partial<
      Pick<
        Doc<"sandboxInstances">,
        | "projectId"
        | "stageId"
        | "sandboxConfigId"
        | "snapshotId"
        | "egress"
        | "permissionMode"
        | "lastUsedTraceId"
        | "lastUsedTaskId"
        | "agentId"
        | "conversationKey"
        | "workspaceName"
        | "workspaceId"
        | "logStream"
        | "ephemeral"
        | "ownCredentials"
      >
    >,
  now: number,
): Pick<
  Doc<"sandboxInstances">,
  "externalId" | "name" | "specs" | "status" | "lastUsedAt"
> &
  Partial<
    Pick<
      Doc<"sandboxInstances">,
      | "projectId"
      | "stageId"
      | "sandboxConfigId"
      | "snapshotId"
      | "egress"
      | "permissionMode"
      | "lastUsedTraceId"
      | "lastUsedTaskId"
      | "agentId"
      | "conversationKey"
      | "workspaceName"
      | "workspaceId"
      | "logStream"
      | "ephemeral"
      | "ownCredentials"
      | "errorMessage"
    >
  > {
  return {
    externalId: args.externalId,
    name: args.name,
    specs: args.specs,
    status: "running" as const,
    // A reconnect only mirrors once the provider handed back a usable sandbox,
    // so the reason goes with the status: `undefined` unsets it on patch and is
    // dropped on insert.
    errorMessage: undefined,
    lastUsedAt: now,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.stageId ? { stageId: args.stageId } : {}),
    ...(args.sandboxConfigId ? { sandboxConfigId: args.sandboxConfigId } : {}),
    ...(args.snapshotId ? { snapshotId: args.snapshotId } : {}),
    ...(args.egress ? { egress: args.egress } : {}),
    ...(args.permissionMode ? { permissionMode: args.permissionMode } : {}),
    ...(args.lastUsedTraceId ? { lastUsedTraceId: args.lastUsedTraceId } : {}),
    ...(args.lastUsedTaskId ? { lastUsedTaskId: args.lastUsedTaskId } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.conversationKey ? { conversationKey: args.conversationKey } : {}),
    ...(args.workspaceName ? { workspaceName: args.workspaceName } : {}),
    ...(args.workspaceId ? { workspaceId: args.workspaceId } : {}),
    ...(args.logStream ? { logStream: args.logStream } : {}),
    ...(args.ephemeral ? { ephemeral: true } : {}),
    // Unset rather than kept: a config moved back to platform credentials is
    // metered again from its next write.
    ownCredentials: args.ownCredentials === true ? true : undefined,
  };
}
