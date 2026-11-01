import { v } from "convex/values";
import { internal } from "../_generated/api";
import { pruneReleasedDashboardSandbox } from "../canvas";
import type { Doc } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
} from "../_generated/server";
import {
  addUsage,
  burstUsage,
  ephemeralSandboxMaxMs,
  sandboxAccrual,
  sandboxIdleMs,
  sandboxLaunchUsage,
} from "../model/usageMeter";
import { getActiveAccountForUser } from "../org/orgs";
import { SANDBOX_RESERVATION_TTL_SECONDS } from "../runtime";
import { sandboxInstancesFields } from "../schema";
import { recordRuntimeAction } from "./auditEvents";

// Every unreleased sandbox (suspended ones still store a snapshot) plus two missed hourly runs.
const ACCRUE_LOOKBACK_MS =
  SANDBOX_RESERVATION_TTL_SECONDS * 1000 + 2 * 60 * 60 * 1000;
// Each instance also reads and writes its meter row: stay far under Convex's read limits.
const ACCRUE_PAGE_SIZE = 100;

const sandboxInstanceDoc = v.object({
  ...sandboxInstancesFields,
  _id: v.id("sandboxInstances"),
  _creationTime: v.number(),
});

// An ephemeral instance belongs to its call: an outside suspend or exec would stop
// its billing mid-call or boot an unmetered machine.
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
      instance.ephemeral !== true &&
      instance.accountId === args.accountId &&
      instance.sandboxConfigId === args.sandboxConfigId,
    );
  },
});

// Rows go on termination and concurrency limits cap the live ones: 1000 is a ceiling.
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
      if (instance.sandboxConfigId) {
        await pruneReleasedDashboardSandbox(ctx, instance.sandboxConfigId);
      }
    }

    return null;
  },
});

// The args are the guest's running totals above baseline; the meter gets the growth.
export const recordBurst = internalMutation({
  args: {
    accountId: v.id("accounts"),
    externalId: v.string(),
    vcpuSeconds: v.number(),
    gbSeconds: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const instance = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!instance || instance.accountId !== args.accountId) return false;
    const burst = burstUsage(instance.burstBilled, {
      vcpuSeconds: args.vcpuSeconds,
      gbSeconds: args.gbSeconds,
    });
    if (instance.ownCredentials !== true) {
      await addUsage(
        ctx,
        instance.accountId,
        burst.usage,
        Date.now(),
        instance.projectId,
      );
    }
    await ctx.db.patch(instance._id, { burstBilled: burst.billed });

    return true;
  },
});

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
      await addUsage(
        ctx,
        accountId,
        sandboxLaunchUsage(instance),
        now,
        instance.projectId,
      );
    }
    await ctx.db.patch(instance._id, {
      meteredUntil: now,
      status: status,
      errorMessage: status === "error" ? errorMessage : undefined,
      // Only a use moves lastUsedAt, never a suspend or a read that observed one.
      ...(status === "running" && !observed ? { lastUsedAt: now } : {}),
      ...(status === "suspended" ? { suspendedAt: now } : {}),
    });

    return instance.status !== status;
  },
});

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
    specsVerified: sandboxInstancesFields.specsVerified,
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
    idleTimeoutSeconds: sandboxInstancesFields.idleTimeoutSeconds,
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
      // The executor found the old machine gone and launched another under the same key.
      const replaced = existing.externalId !== args.externalId;
      await accrue(ctx, existing, now);
      // Past its idle timeout the provider suspended it, so it loads its snapshot again.
      if (
        replaced ||
        existing.status === "suspended" ||
        now > existing.lastUsedAt + sandboxIdleMs(existing)
      ) {
        await addUsage(
          ctx,
          args.accountId,
          sandboxLaunchUsage(args),
          now,
          args.projectId ?? existing.projectId,
        );
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
        ...(replaced ? { burstBilled: undefined } : {}),
        ...keptVerifiedSize(existing, args.specsVerified, replaced),
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
    await addUsage(
      ctx,
      args.accountId,
      sandboxLaunchUsage(args),
      now,
      args.projectId,
    );
    await recordRuntimeAction(ctx, row, "reserve");

    return null;
  },
});

// A late size report (an e2b read) must never revive a removed or repointed row.
export const setSpecs = internalMutation({
  args: {
    accountId: v.id("accounts"),
    reservationKey: v.string(),
    externalId: v.string(),
    specs: sandboxInstancesFields.specs,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const instance = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) =>
        q.eq("reservationKey", args.reservationKey),
      )
      .unique();
    if (
      !instance ||
      instance.accountId !== args.accountId ||
      instance.externalId !== args.externalId
    ) {
      return null;
    }
    const now = Date.now();
    await accrue(ctx, instance, now);
    await ctx.db.patch(instance._id, {
      specs: args.specs,
      specsVerified: true,
      meteredUntil: now,
    });

    return null;
  },
});

// Hourly, for sandboxes nothing wrote to; every page bills up to the same `now`.
export const accrueRecent = internalMutation({
  args: {
    now: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const now = args.now ?? Date.now();
    if (args.cursor === undefined) {
      await ctx.scheduler.runAfter(
        0,
        internal.sandbox.instances.sweepStaleEphemeral,
        { now: now },
      );
    }
    const page = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_lastUsedAt", (q) =>
        q.gte("lastUsedAt", now - ACCRUE_LOOKBACK_MS),
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

// A lost teardown must not leave an ephemeral row billing or crowding the dashboard.
export const sweepStaleEphemeral = internalMutation({
  args: { now: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    // Past the longer of the two per-call ceilings, any provider's call is over.
    const staleBefore =
      args.now -
      Math.max(
        ephemeralSandboxMaxMs("lambda"),
        ephemeralSandboxMaxMs("sandbox"),
      );
    const stale = await ctx.db
      .query("sandboxInstances")
      .withIndex("by_ephemeral_and_lastUsedAt", (q) =>
        q.eq("ephemeral", true).lt("lastUsedAt", staleBefore),
      )
      .take(ACCRUE_PAGE_SIZE);
    for (const instance of stale) {
      await accrue(ctx, instance, args.now);
      await ctx.db.delete(instance._id);
      if (instance.sandboxConfigId) {
        await pruneReleasedDashboardSandbox(ctx, instance.sandboxConfigId);
      }
    }
    if (stale.length === ACCRUE_PAGE_SIZE) {
      await ctx.scheduler.runAfter(
        0,
        internal.sandbox.instances.sweepStaleEphemeral,
        { now: args.now },
      );
    }

    return null;
  },
});

async function accrue(
  ctx: MutationCtx,
  instance: Doc<"sandboxInstances">,
  now: number,
): Promise<number> {
  const accrual = sandboxAccrual(instance, now);
  await addUsage(
    ctx,
    instance.accountId,
    accrual.usage,
    now,
    instance.projectId,
  );

  return accrual.meteredUntil;
}

// A size-less write (a workdir or e2b reconnect) must not unverify the same machine.
function keptVerifiedSize(
  existing: Doc<"sandboxInstances">,
  specsVerified: boolean | undefined,
  replaced: boolean,
): Partial<Pick<Doc<"sandboxInstances">, "specs" | "specsVerified">> {
  return !replaced && existing.specsVerified && !specsVerified
    ? { specs: existing.specs, specsVerified: true }
    : {};
}

function upsertRefreshFields(
  args: Pick<Doc<"sandboxInstances">, "externalId" | "name" | "specs"> &
    Partial<
      Pick<
        Doc<"sandboxInstances">,
        | "specsVerified"
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
        | "idleTimeoutSeconds"
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
      | "specsVerified"
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
      | "idleTimeoutSeconds"
      | "errorMessage"
    >
  > {
  return {
    externalId: args.externalId,
    name: args.name,
    specs: args.specs,
    specsVerified: args.specsVerified,
    status: "running" as const,
    // Mirrored only once the provider handed back a usable sandbox, so any old error goes.
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
    // Unset, not kept: a config moved back to platform credentials is metered again.
    ownCredentials: args.ownCredentials === true ? true : undefined,
    ...(args.idleTimeoutSeconds !== undefined
      ? { idleTimeoutSeconds: args.idleTimeoutSeconds }
      : {}),
  };
}
