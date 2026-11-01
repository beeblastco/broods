import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  asyncAgentOutcomeValidator,
  asyncAgentResultRow,
  asyncToolResultRow,
  conversationEventsValidator,
  insertConversationEvents,
  markResultStored,
  writeAsyncAgentResult,
} from "./runtime";
import {
  channelTargetRefsFields,
  ingressConfigRefValidator,
  ingressDeliveryValidator,
  ingressModeValidator,
  ingressStatusValidator,
  publicDeploymentIngressValidator,
  runtimeHarnessSessionsFields,
  systemModelMessageValidator,
} from "./schema";
import { accountIdFromKey, requireActiveAccount } from "./model/activeAccount";
import {
  asyncToolResultDedupeKey,
  subagentResultDedupeKey,
} from "./model/subagentResults";

const CLEAR_BATCH_SIZE = 100;
// Harness checkpoints hold session ids, never chat history: a bigger one is an adapter bug.
const MAX_HARNESS_RESUME_STATE_BYTES = 64 * 1_024;

// Terminal rows keep a stale expiresAt through retention; scanning them rereads every payload.
const EXPIRABLE_STATUSES = ["queued", "processing"] as const;

const MAX_DRAIN_ENVELOPES = 100;

const RENEW_AFTER_TTL_FRACTION = 0.9;

const TERMINAL_STATUSES = ["completed", "failed", "expired"] as const;

// Duplicate replay compares only payloadDigest, so a settled row need not keep its payload.
const RELEASED_PAYLOAD = {
  events: [],
  configRef: undefined,
  ephemeralSystem: undefined,
};

const appliedEnvelopeValidator = v.object({
  eventId: v.string(),
  events: v.array(v.any()),
  delivery: ingressDeliveryValidator,
  requestedMode: ingressModeValidator,
  appliedMode: ingressModeValidator,
  appliedToEventId: v.string(),
  contributingEventIds: v.array(v.string()),
  ownerGeneration: v.number(),
  configRef: v.optional(ingressConfigRefValidator),
  ephemeralSystem: v.optional(v.array(systemModelMessageValidator)),
});

const admissionResultValidator = v.object({
  outcome: v.union(
    v.literal("owner"),
    v.literal("queued"),
    v.literal("duplicate"),
    v.literal("rejected"),
    v.literal("capacity"),
    v.literal("conflict"),
    v.literal("not_running"),
  ),
  eventId: v.optional(v.string()),
  // On a duplicate, the first admission's run id, so an idempotent POST keeps one run id.
  runId: v.optional(v.string()),
  status: v.optional(ingressStatusValidator),
  ownerGeneration: v.optional(v.number()),
  sequence: v.optional(v.number()),
  // Queued work promoted off an expired owner; the caller must schedule it.
  recovered: v.optional(appliedEnvelopeValidator),
});

const recoveredIngressValidator = v.object({
  accountId: v.id("accounts"),
  agentId: v.string(),
  conversationKey: v.string(),
  applied: appliedEnvelopeValidator,
});

// Only the refs core rebuilds a run's config from: the config itself holds decrypted secrets.
const channelTargetFields = {
  channelName: v.string(),
  source: v.record(v.string(), v.any()),
  ...channelTargetRefsFields,
};

const channelTargetValidator = v.object(channelTargetFields);

const ingressStatusResultValidator = v.object({
  eventId: v.string(),
  runId: v.string(),
  agentId: v.string(),
  conversationKey: v.string(),
  requestedMode: ingressModeValidator,
  appliedMode: v.optional(ingressModeValidator),
  appliedToEventId: v.optional(v.string()),
  status: ingressStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  expiresAt: v.number(),
  error: v.optional(v.string()),
  stoppedByUser: v.optional(v.boolean()),
  result: v.optional(v.any()),
  publicDeploymentIngress: v.optional(publicDeploymentIngressValidator),
});

const ownerRenewalResultValidator = v.union(
  v.literal("renewed"),
  v.literal("stopped"),
  v.literal("stale"),
);

const stepBoundaryResultValidator = v.object({
  renewal: ownerRenewalResultValidator,
  steering: v.union(appliedEnvelopeValidator, v.null()),
});

type PublicDeploymentIngress = Infer<typeof publicDeploymentIngressValidator>;

/** Rejected busy candidates create neither an envelope nor an identity tombstone. */
export const accept = internalMutation({
  args: {
    activeOwnerOnly: v.optional(v.boolean()),
    expectedOwnerTaskId: v.optional(v.string()),
    ownerTaskId: v.optional(v.string()),
    accountId: v.id("accounts"),
    agentId: v.string(),
    conversationKey: v.string(),
    eventId: v.string(),
    runId: v.string(),
    idempotencyKey: v.string(),
    payloadDigest: v.string(),
    events: v.array(v.any()),
    delivery: ingressDeliveryValidator,
    requestedMode: ingressModeValidator,
    configRef: v.optional(ingressConfigRefValidator),
    channelTarget: v.optional(channelTargetValidator),
    ephemeralSystem: v.optional(v.array(systemModelMessageValidator)),
    sizeBytes: v.number(),
    leaseTtlMs: v.number(),
    envelopeTtlMs: v.number(),
    statusTtlMs: v.number(),
    maxQueuedCount: v.number(),
    maxQueuedBytes: v.number(),
    // Result rows a late-result resume delivers: admitted only until stored, stored once run.
    resultEventId: v.optional(v.string()),
    toolResultId: v.optional(v.string()),
  },
  returns: admissionResultValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof admissionResultValidator>> => {
    await requireActiveAccount(ctx, args.accountId);
    assertConversationScope(args.accountId, args.agentId, args.conversationKey);
    if (args.sizeBytes < 0)
      throw new Error("Ingress size must not be negative");
    const now = Date.now();
    const identity = await canonicalIdentity(args);
    const priorAdmission = await checkDuplicateAdmission(ctx, args, identity);
    if (priorAdmission) {
      return priorAdmission;
    }
    const prepared = await prepareAdmissionCoordinator(ctx, args, now);
    let coordinator = prepared.coordinator;
    const queue = prepared.queue;
    // Before recovery: a late control must not take the owner slot recovery hands to queued work.
    const lateControl = isLateControl(args, coordinator, now);

    // FIFO: work queued behind an expired owner runs before this arrival.
    let recovered: Awaited<ReturnType<typeof promoteQueuedGroup>> = null;
    if (!hasActiveOwner(coordinator, now) && queue.queuedCount > 0) {
      recovered = await promoteQueuedGroup(ctx, {
        coordinator: coordinator,
        queue: queue,
        rows: prepared.rows,
        now: now,
        leaseTtlMs: args.leaseTtlMs,
        ownerGeneration: coordinator.ownerGeneration + 1,
      });
      if (recovered) {
        coordinator = (await ctx.db.get(coordinator._id))!;
      }
    }

    if (lateControl) {
      return {
        outcome: "not_running" as const,
        ...(recovered ? { recovered: recovered } : {}),
      };
    }

    const busy = hasActiveOwner(coordinator, now);
    if (busy && args.requestedMode === "reject") {
      return {
        outcome: "rejected" as const,
        ...(recovered ? { recovered: recovered } : {}),
      };
    }
    if (
      busy &&
      (coordinator.queuedCount >= args.maxQueuedCount ||
        coordinator.queuedBytes + args.sizeBytes > args.maxQueuedBytes)
    ) {
      return {
        outcome: "capacity" as const,
        ...(recovered ? { recovered: recovered } : {}),
      };
    }

    const sequence = coordinator.nextSequence;
    const baseEnvelope = buildAdmissionEnvelope(args, identity, sequence, now);
    if (busy) {
      await ctx.db.insert("runtimeIngressEnvelopes", {
        ...baseEnvelope,
        status: "queued",
      });
      await ctx.db.patch(coordinator._id, {
        nextSequence: sequence + 1,
        queuedCount: coordinator.queuedCount + 1,
        queuedBytes: coordinator.queuedBytes + args.sizeBytes,
        updatedAt: now,
      });

      return {
        outcome: "queued" as const,
        eventId: args.eventId,
        runId: args.runId,
        status: "queued" as const,
        sequence: sequence,
        ...(recovered ? { recovered: recovered } : {}),
      };
    }

    const ownerGeneration = coordinator.ownerGeneration + 1;
    const appliedMode =
      args.requestedMode === "steer" ? "followup" : args.requestedMode;
    await markDeliveredResultsStored(ctx, baseEnvelope);
    await ctx.db.insert("runtimeIngressEnvelopes", {
      ...baseEnvelope,
      appliedMode: appliedMode,
      appliedToEventId: args.eventId,
      ownerGeneration: ownerGeneration,
      status: "processing",
    });
    await ctx.db.patch(coordinator._id, {
      nextSequence: sequence + 1,
      ownerGeneration: ownerGeneration,
      ownerEventId: args.eventId,
      ownerTaskId: args.ownerTaskId,
      stopRequestedGeneration: undefined,
      leaseExpiresAt: now + args.leaseTtlMs,
      updatedAt: now,
    });

    return {
      outcome: "owner" as const,
      eventId: args.eventId,
      runId: args.runId,
      status: "processing" as const,
      ownerGeneration: ownerGeneration,
      sequence: sequence,
    };
  },
});

export const acquireClear = internalMutation({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    conversationKey: v.string(),
    ownerEventId: v.string(),
    leaseTtlMs: v.number(),
  },
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, args): Promise<number | null> => {
    await requireActiveAccount(ctx, args.accountId);
    assertConversationScope(args.accountId, args.agentId, args.conversationKey);
    const now = Date.now();
    const coordinator =
      (await getCoordinator(ctx, args.conversationKey)) ??
      (await createCoordinator(ctx, {
        accountId: args.accountId,
        agentId: args.agentId,
        conversationKey: args.conversationKey,
        now: now,
      }));
    const queue = await expireQueuedEnvelopes(ctx, coordinator, now);
    if (hasActiveOwner(coordinator, now) || queue.queuedCount > 0) {
      await patchQueueCounters(ctx, coordinator, queue, now);

      return null;
    }
    const generation = coordinator.ownerGeneration + 1;
    await ctx.db.patch(coordinator._id, {
      ownerGeneration: generation,
      ownerEventId: args.ownerEventId,
      stopRequestedGeneration: undefined,
      leaseExpiresAt: now + args.leaseTtlMs,
      queuedCount: queue.queuedCount,
      queuedBytes: queue.queuedBytes,
      updatedAt: now,
    });

    return generation;
  },
});

export const appendConversationEvent = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    events: conversationEventsValidator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const coordinator = await requireOwner(ctx, args);
    await insertOwnedEvents(ctx, coordinator, args.events);

    return null;
  },
});

export const applySteering = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    leaseTtlMs: v.number(),
    // A harness turn takes a steer only as text; the rest stays queued for the next turn.
    textOnly: v.optional(v.boolean()),
  },
  returns: v.union(appliedEnvelopeValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof appliedEnvelopeValidator> | null> => {
    const now = Date.now();
    const coordinator = await requireOwner(ctx, { ...args, now: now });

    return await claimSteering(ctx, coordinator, args, now);
  },
});

export const clearConversation = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ deleted: number; hasMore: boolean }> => {
    const coordinator = await requireOwner(ctx, args);
    await requireActiveAccount(ctx, coordinator.accountId);
    const rows = await ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_cursor", (q) =>
        q.eq("conversationKey", args.conversationKey),
      )
      .take(CLEAR_BATCH_SIZE + 1);
    const batch = rows.slice(0, CLEAR_BATCH_SIZE);
    for (const row of batch) await ctx.db.delete(row._id);
    const harnessSession = await ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_conversationKey", (q) =>
        q.eq("conversationKey", args.conversationKey),
      )
      .unique();
    if (harnessSession) await ctx.db.delete(harnessSession._id);

    return {
      deleted: batch.length,
      hasMore: rows.length > CLEAR_BATCH_SIZE,
    };
  },
});

export const saveHarnessSession = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    harnessType: runtimeHarnessSessionsFields.harnessType,
    sessionId: v.string(),
    resumeState: v.any(),
    reservationKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const coordinator = await requireOwner(ctx, args);
    await requireActiveAccount(ctx, coordinator.accountId);
    const serializedResumeState = JSON.stringify(args.resumeState);
    if (serializedResumeState === undefined) {
      throw new Error("Harness resume state must be JSON serializable");
    }
    const resumeStateBytes = new TextEncoder().encode(
      serializedResumeState,
    ).byteLength;
    if (resumeStateBytes > MAX_HARNESS_RESUME_STATE_BYTES) {
      throw new Error(
        `Harness resume state is ${resumeStateBytes} bytes; the maximum is ${MAX_HARNESS_RESUME_STATE_BYTES}`,
      );
    }
    const existing = await ctx.db
      .query("runtimeHarnessSessions")
      .withIndex("by_conversationKey", (q) =>
        q.eq("conversationKey", args.conversationKey),
      )
      .unique();
    const value = {
      accountId: coordinator.accountId,
      conversationKey: args.conversationKey,
      harnessType: args.harnessType,
      sessionId: args.sessionId,
      resumeState: args.resumeState,
      reservationKey: args.reservationKey,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.replace(existing._id, value);
    } else {
      await ctx.db.insert("runtimeHarnessSessions", value);
    }

    return null;
  },
});

export const getConversationTarget = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    conversationKey: v.string(),
  },
  returns: v.union(channelTargetValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof channelTargetValidator> | null> => {
    assertConversationScope(args.accountId, args.agentId, args.conversationKey);
    const coordinator = await getCoordinator(ctx, args.conversationKey);
    const target = coordinator?.channelTarget;
    if (
      !target ||
      coordinator.accountId !== args.accountId ||
      coordinator.agentId !== args.agentId
    ) {
      return null;
    }

    return target;
  },
});

export const getStatus = internalQuery({
  args: {
    accountId: v.id("accounts"),
    runId: v.string(),
  },
  returns: v.union(ingressStatusResultValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof ingressStatusResultValidator> | null> => {
    // Account-scoped at the index: a guessed run id cannot read across accounts.
    const row = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_accountId_and_runId", (q) =>
        q.eq("accountId", args.accountId).eq("runId", args.runId),
      )
      .unique();
    if (!row) return null;

    return ingressStatusResult(row);
  },
});

/** For the subagent-parent auth check: it knows the parent's event id, not its run id. */
export const getStatusByEventId = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    eventId: v.string(),
  },
  returns: v.union(ingressStatusResultValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof ingressStatusResultValidator> | null> => {
    const row = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (
      !row ||
      row.accountId !== args.accountId ||
      row.agentId !== args.agentId
    ) {
      return null;
    }

    return ingressStatusResult(row);
  },
});

export const isCurrentOwner = internalQuery({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    try {
      await requireOwner(ctx, args);

      return true;
    } catch {
      return false;
    }
  },
});

export const maintain = internalMutation({
  args: {},
  returns: v.object({ expired: v.number(), deleted: v.number() }),
  handler: async (ctx): Promise<{ expired: number; deleted: number }> => {
    const now = Date.now();
    const dueBatches = await Promise.all(
      EXPIRABLE_STATUSES.map((status) =>
        ctx.db
          .query("runtimeIngressEnvelopes")
          .withIndex("by_status_and_expiresAt", (q) =>
            q.eq("status", status).lte("expiresAt", now),
          )
          .take(MAX_DRAIN_ENVELOPES),
      ),
    );
    const due = dueBatches.flat();
    let expired = 0;
    for (const row of due) {
      const coordinator = await getCoordinator(ctx, row.conversationKey);
      if (
        row.status === "processing" &&
        coordinator &&
        hasActiveOwner(coordinator, now) &&
        row.ownerGeneration === coordinator.ownerGeneration
      ) {
        // Off the due range, or long live runs fill every batch and starve real expiries.
        await ctx.db.patch(row._id, { expiresAt: coordinator.leaseExpiresAt });
        continue;
      }
      await ctx.db.patch(row._id, {
        ...RELEASED_PAYLOAD,
        status: "expired",
        error:
          row.status === "queued"
            ? "Ingress expired before it reached a runnable boundary"
            : "Conversation owner lease expired before completion",
        updatedAt: now,
      });
      expired += 1;
      if (coordinator && row.status === "queued") {
        await ctx.db.patch(coordinator._id, {
          queuedCount: Math.max(0, coordinator.queuedCount - 1),
          queuedBytes: Math.max(0, coordinator.queuedBytes - row.sizeBytes),
          updatedAt: now,
        });
      } else if (
        coordinator?.ownerEventId &&
        row.ownerGeneration === coordinator.ownerGeneration &&
        !hasActiveOwner(coordinator, now)
      ) {
        await ctx.db.patch(coordinator._id, {
          ownerEventId: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
      }
    }

    const retainedBatches = await Promise.all(
      TERMINAL_STATUSES.map((status) =>
        ctx.db
          .query("runtimeIngressEnvelopes")
          .withIndex("by_status_and_statusExpiresAt", (q) =>
            q.eq("status", status).lte("statusExpiresAt", now),
          )
          .take(MAX_DRAIN_ENVELOPES),
      ),
    );
    let deleted = 0;
    for (const row of retainedBatches.flat()) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    const applications = await ctx.db
      .query("runtimeIngressApplications")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(MAX_DRAIN_ENVELOPES);
    for (const row of applications) await ctx.db.delete(row._id);

    if (
      dueBatches.some((batch) => batch.length === MAX_DRAIN_ENVELOPES) ||
      retainedBatches.some((batch) => batch.length === MAX_DRAIN_ENVELOPES) ||
      applications.length === MAX_DRAIN_ENVELOPES
    ) {
      await ctx.scheduler.runAfter(0, internal.runtimeIngress.maintain, {});
    }

    return { expired: expired, deleted: deleted };
  },
});

/**
 * For queues nobody writes to again, e.g. behind a run core handed back at shutdown.
 * The caller holds each returned lease and must dispatch it.
 */
export const recoverQueued = internalMutation({
  args: {
    leaseTtlMs: v.number(),
    afterConversationKey: v.optional(v.string()),
  },
  returns: v.object({
    recovered: v.array(recoveredIngressValidator),
    continueAfter: v.union(v.string(), v.null()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    recovered: Infer<typeof recoveredIngressValidator>[];
    continueAfter: string | null;
  }> => {
    const now = Date.now();
    const recovered: Infer<typeof recoveredIngressValidator>[] = [];
    let after = args.afterConversationKey;
    for (let visited = 0; visited < MAX_DRAIN_ENVELOPES; visited += 1) {
      const row = await ctx.db
        .query("runtimeIngressEnvelopes")
        .withIndex("by_status_and_conversationKey", (q) =>
          after === undefined
            ? q.eq("status", "queued")
            : q.eq("status", "queued").gt("conversationKey", after),
        )
        .first();
      if (!row) return { recovered: recovered, continueAfter: null };
      after = row.conversationKey;
      const coordinator = await getCoordinator(ctx, row.conversationKey);
      if (!coordinator || hasActiveOwner(coordinator, now)) continue;
      const account = await ctx.db.get(coordinator.accountId);
      if (account?.status !== "active") continue;
      await expireStaleOwner(ctx, coordinator, now);
      // The self-heal: reads past the counter, and a short page is the whole queue.
      const rows = await queuedEnvelopes(ctx, coordinator.conversationKey);
      const swept = await expireQueuedEnvelopes(ctx, coordinator, now, rows);
      const live = rows.filter((row) => row.expiresAt > now);
      const queue =
        rows.length < MAX_DRAIN_ENVELOPES
          ? {
              queuedCount: live.length,
              queuedBytes: live.reduce(
                (total, row) => total + row.sizeBytes,
                0,
              ),
            }
          : swept;
      const applied = await promoteQueuedGroup(ctx, {
        coordinator: coordinator,
        queue: queue,
        rows: rows,
        now: now,
        leaseTtlMs: args.leaseTtlMs,
        ownerGeneration: coordinator.ownerGeneration + 1,
      });
      if (!applied) {
        await patchQueueCounters(ctx, coordinator, queue, now);
        continue;
      }
      recovered.push({
        accountId: coordinator.accountId,
        agentId: coordinator.agentId,
        conversationKey: coordinator.conversationKey,
        applied: applied,
      });
    }

    return { recovered: recovered, continueAfter: after ?? null };
  },
});

export const releaseOwner = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const coordinator = await getCoordinator(ctx, args.conversationKey);
    if (
      !coordinator ||
      coordinator.ownerEventId !== args.ownerEventId ||
      coordinator.ownerGeneration !== args.ownerGeneration
    ) {
      return false;
    }
    await ctx.db.patch(coordinator._id, {
      ownerEventId: undefined,
      stopRequestedGeneration: undefined,
      leaseExpiresAt: undefined,
      updatedAt: Date.now(),
    });

    return true;
  },
});

export const renewOwner = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    leaseTtlMs: v.number(),
  },
  returns: ownerRenewalResultValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof ownerRenewalResultValidator>> => {
    const now = Date.now();
    let coordinator: Doc<"runtimeConversationCoordinators">;
    try {
      coordinator = await requireOwner(ctx, { ...args, now: now });
    } catch {
      return "stale" as const;
    }
    if (coordinator.stopRequestedGeneration === args.ownerGeneration) {
      return "stopped" as const;
    }
    await renewHeldLease(ctx, coordinator, args.leaseTtlMs, now);

    return "renewed" as const;
  },
});

export const settle = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    status: v.union(v.literal("completed"), v.literal("failed")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    asyncResult: v.optional(
      v.object({
        eventIds: v.array(v.string()),
        outcome: asyncAgentOutcomeValidator,
      }),
    ),
    events: v.optional(conversationEventsValidator),
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const coordinator = await requireOwner(ctx, args);
    if (args.events && args.events.length > 0) {
      await insertOwnedEvents(ctx, coordinator, args.events);
    }
    const settled = await settleAppliedEnvelopes(ctx, coordinator, args);
    // Only with the owner's own envelope, so polling rows never disagree with it.
    if (args.asyncResult && settled.ownerFinished) {
      for (const eventId of args.asyncResult.eventIds) {
        await writeAsyncAgentResult(ctx, eventId, args.asyncResult.outcome);
      }
    }

    return settled.count;
  },
});

export const stepBoundary = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    leaseTtlMs: v.number(),
    events: v.optional(conversationEventsValidator),
    claimSteering: v.optional(v.boolean()),
  },
  returns: stepBoundaryResultValidator,
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof stepBoundaryResultValidator>> => {
    const now = Date.now();
    let coordinator: Doc<"runtimeConversationCoordinators">;
    try {
      coordinator = await requireOwner(ctx, { ...args, now: now });
    } catch {
      return { renewal: "stale" as const, steering: null };
    }
    if (args.events && args.events.length > 0) {
      await insertOwnedEvents(ctx, coordinator, args.events);
    }
    if (coordinator.stopRequestedGeneration === args.ownerGeneration) {
      return { renewal: "stopped" as const, steering: null };
    }
    // A claimed steer extends the lease itself.
    const steering =
      args.claimSteering === false
        ? null
        : await claimSteering(ctx, coordinator, args, now);
    if (!steering) await renewHeldLease(ctx, coordinator, args.leaseTtlMs, now);

    return { renewal: "renewed" as const, steering: steering };
  },
});

export const stopOwner = internalMutation({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    conversationKey: v.string(),
    expectedOwnerTaskId: v.optional(v.string()),
  },
  returns: v.object({ stopped: v.boolean(), queuedCount: v.number() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ stopped: boolean; queuedCount: number }> => {
    await requireActiveAccount(ctx, args.accountId);
    assertConversationScope(args.accountId, args.agentId, args.conversationKey);
    const now = Date.now();
    const coordinator = await getCoordinator(ctx, args.conversationKey);
    if (
      !coordinator ||
      !hasActiveOwner(coordinator, now) ||
      (args.expectedOwnerTaskId !== undefined &&
        coordinator.ownerTaskId !== args.expectedOwnerTaskId)
    ) {
      return { stopped: false, queuedCount: coordinator?.queuedCount ?? 0 };
    }
    await ctx.db.patch(coordinator._id, {
      stopRequestedGeneration: coordinator.ownerGeneration,
      // Only a parent's stop_subagent names the task it stops.
      stopRequestedByParent: args.expectedOwnerTaskId !== undefined,
      updatedAt: now,
    });

    return { stopped: true, queuedCount: coordinator.queuedCount };
  },
});

export const takeNext = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    leaseTtlMs: v.number(),
    settle: v.optional(
      v.object({
        status: v.union(v.literal("completed"), v.literal("failed")),
        result: v.optional(v.any()),
        error: v.optional(v.string()),
      }),
    ),
    events: v.optional(conversationEventsValidator),
  },
  returns: v.union(appliedEnvelopeValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof appliedEnvelopeValidator> | null> => {
    const now = Date.now();
    const coordinator = await requireOwner(ctx, { ...args, now: now });
    if (args.events && args.events.length > 0) {
      await insertOwnedEvents(ctx, coordinator, args.events);
    }
    if (args.settle) {
      await settleAppliedEnvelopes(ctx, coordinator, {
        ...args,
        ...args.settle,
      });
    }
    const rows = await queuedPage(ctx, coordinator);
    const queue = await expireQueuedEnvelopes(ctx, coordinator, now, rows);
    const promoted = await promoteQueuedGroup(ctx, {
      coordinator: coordinator,
      queue: queue,
      rows: rows,
      now: now,
      leaseTtlMs: args.leaseTtlMs,
      ownerGeneration: args.ownerGeneration + 1,
    });
    if (!promoted) {
      await ctx.db.patch(coordinator._id, {
        ...queue,
        ownerEventId: undefined,
        ownerTaskId: undefined,
        stopRequestedGeneration: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      });

      return null;
    }

    return promoted;
  },
});

function assertConversationScope(
  accountId: string,
  agentId: string,
  conversationKey: string,
): void {
  if (accountIdFromKey(conversationKey) !== accountId) {
    throw new Error("Runtime conversation does not belong to accountId");
  }
  if (!conversationKey.includes(`:agent:${agentId}:`)) {
    throw new Error("Runtime conversation does not belong to agentId");
  }
}

function buildAdmissionEnvelope(
  args: {
    accountId: Id<"accounts">;
    agentId: string;
    conversationKey: string;
    eventId: string;
    runId: string;
    idempotencyKey: string;
    payloadDigest: string;
    events: unknown[];
    delivery: Infer<typeof ingressDeliveryValidator>;
    requestedMode: Infer<typeof ingressModeValidator>;
    ownerTaskId?: string;
    configRef?: Infer<typeof ingressConfigRefValidator>;
    ephemeralSystem?: Infer<typeof systemModelMessageValidator>[];
    resultEventId?: string;
    toolResultId?: string;
    sizeBytes: number;
    envelopeTtlMs: number;
    statusTtlMs: number;
  },
  identity: string,
  sequence: number,
  now: number,
): Omit<Doc<"runtimeIngressEnvelopes">, "_id" | "_creationTime" | "status"> {
  return {
    accountId: args.accountId,
    agentId: args.agentId,
    conversationKey: args.conversationKey,
    sequence: sequence,
    eventId: args.eventId,
    runId: args.runId,
    identity: identity,
    idempotencyKey: args.idempotencyKey,
    payloadDigest: args.payloadDigest,
    events: args.events,
    delivery: args.delivery,
    requestedMode: args.requestedMode,
    ...(args.ownerTaskId !== undefined
      ? { ownerTaskId: args.ownerTaskId }
      : {}),
    ...(args.configRef !== undefined ? { configRef: args.configRef } : {}),
    ...(args.ephemeralSystem !== undefined
      ? { ephemeralSystem: args.ephemeralSystem }
      : {}),
    ...(args.resultEventId !== undefined
      ? { resultEventId: args.resultEventId }
      : {}),
    ...(args.toolResultId !== undefined
      ? { toolResultId: args.toolResultId }
      : {}),
    sizeBytes: args.sizeBytes,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + args.envelopeTtlMs,
    statusExpiresAt: now + args.statusTtlMs,
  };
}

async function canonicalIdentity(options: {
  accountId: string;
  agentId: string;
  conversationKey: string;
  idempotencyKey: string;
}): Promise<string> {
  const value = JSON.stringify([
    options.accountId,
    options.agentId,
    options.conversationKey,
    options.idempotencyKey,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Writes only to let a late result through once; null means the candidate is new. */
async function checkDuplicateAdmission(
  ctx: MutationCtx,
  args: {
    accountId: Id<"accounts">;
    conversationKey: string;
    eventId: string;
    payloadDigest: string;
    resultEventId?: string;
    toolResultId?: string;
  },
  identity: string,
): Promise<Infer<typeof admissionResultValidator> | null> {
  const existing = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_identity", (q) => q.eq("identity", identity))
    .unique();
  if (existing && (await expiredUndeliveredResume(ctx, existing))) {
    await ctx.db.delete(existing._id);
  } else if (existing) {
    // A sweep retry of a queued resume can drift (hook rewrite, model redeploy): same result.
    if (
      existing.payloadDigest !== args.payloadDigest &&
      !resumesSameResult(existing, args)
    ) {
      return { outcome: "conflict" as const, eventId: existing.eventId };
    }

    return {
      outcome: "duplicate" as const,
      eventId: existing.eventId,
      runId: existing.runId,
      status: existing.status,
      ...(existing.ownerGeneration !== undefined
        ? { ownerGeneration: existing.ownerGeneration }
        : {}),
      sequence: existing.sequence,
    };
  }
  const existingEvent = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_eventId", (q) => q.eq("eventId", args.eventId))
    .unique();
  if (existingEvent) {
    return { outcome: "conflict" as const, eventId: existingEvent.eventId };
  }
  // A status read and a late resume race to deliver one result; the first to mark it stored wins.
  const result = await asyncAgentResultRow(ctx, args.resultEventId);
  if (result?.accountId === args.accountId) {
    return await storedResultAdmission(ctx, args, result, (status): string =>
      subagentResultDedupeKey(result.eventId, status),
    );
  }
  const toolResult = await asyncToolResultRow(ctx, args.toolResultId);
  if (toolResult?.accountId === args.accountId) {
    return await storedResultAdmission(
      ctx,
      args,
      toolResult,
      (status): string => asyncToolResultDedupeKey(toolResult.resultId, status),
    );
  }

  return null;
}

async function storedResultAdmission(
  ctx: MutationCtx,
  args: { conversationKey: string; eventId: string },
  result: Doc<"runtimeAsyncAgentResults"> | Doc<"runtimeAsyncToolResults">,
  dedupeKeyFor: (status: "completed" | "failed") => string,
): Promise<Infer<typeof admissionResultValidator> | null> {
  if (result.handback === "stored") {
    return { outcome: "duplicate" as const, eventId: args.eventId };
  }
  // A write that stored the result but lost its reply left it here. Both keys: the row can
  // still read `processing` while the conversation holds the result its run saw.
  for (const status of ["completed", "failed"] as const) {
    const stored = await ctx.db
      .query("runtimeConversationEvents")
      .withIndex("by_conversationKey_and_dedupeKey", (q) =>
        q
          .eq("conversationKey", args.conversationKey)
          .eq("dedupeKey", dedupeKeyFor(status)),
      )
      .first();
    if (stored) {
      await markResultStored(ctx, result.accountId, result);

      return { outcome: "duplicate" as const, eventId: args.eventId };
    }
  }

  return null;
}

// Applying a resume marks its result stored, so an unstored one was never delivered.
async function expiredUndeliveredResume(
  ctx: QueryCtx,
  envelope: Doc<"runtimeIngressEnvelopes">,
): Promise<boolean> {
  if (envelope.status !== "expired") return false;
  const rows = [
    await asyncAgentResultRow(ctx, envelope.resultEventId),
    await asyncToolResultRow(ctx, envelope.toolResultId),
  ];

  return rows.some(
    (row): boolean =>
      row?.accountId === envelope.accountId && row.handback !== "stored",
  );
}

async function claimSteering(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  args: {
    conversationKey: string;
    ownerEventId: string;
    ownerGeneration: number;
    leaseTtlMs: number;
    textOnly?: boolean;
  },
  now: number,
): Promise<Infer<typeof appliedEnvelopeValidator> | null> {
  // A stop landing after core's renew leaves the steer queued for the next turn.
  if (coordinator.stopRequestedGeneration === args.ownerGeneration) {
    return null;
  }
  const rows = await queuedPage(ctx, coordinator);
  const queue = await expireQueuedEnvelopes(ctx, coordinator, now, rows);
  const active = rows.filter((row) => row.expiresAt > now);
  const steering = active[0]?.requestedMode === "steer";
  // A steer joins the running turn, so it must come from that turn's sender.
  const owner = steering
    ? await ctx.db
        .query("runtimeIngressEnvelopes")
        .withIndex("by_eventId", (q) => q.eq("eventId", args.ownerEventId))
        .unique()
    : null;
  const prefix = steering ? contiguousModePrefix(active, owner?.delivery) : [];
  const firstNotText = args.textOnly
    ? prefix.findIndex((row) => !row.events.every(isPlainUserText))
    : -1;
  const selected = firstNotText === -1 ? prefix : prefix.slice(0, firstNotText);
  if (selected.length === 0) {
    await patchQueueCounters(ctx, coordinator, queue, now, {
      leaseExpiresAt: now + args.leaseTtlMs,
    });

    return null;
  }
  const eventIds = selected.map((row) => row.eventId);
  const applicationId = `${args.ownerEventId}:steer:${args.ownerGeneration}:${selected[0]!.sequence}`;
  for (const row of selected) {
    await markDeliveredResultsStored(ctx, row);
    await ctx.db.patch(row._id, {
      status: "processing",
      appliedMode: "steer",
      appliedToEventId: args.ownerEventId,
      applicationId: applicationId,
      ownerGeneration: args.ownerGeneration,
      updatedAt: now,
    });
  }
  await ctx.db.insert("runtimeIngressApplications", {
    accountId: coordinator.accountId,
    conversationKey: args.conversationKey,
    applicationId: applicationId,
    appliedMode: "steer",
    appliedToEventId: args.ownerEventId,
    contributingEventIds: eventIds,
    ownerGeneration: args.ownerGeneration,
    createdAt: now,
    expiresAt: Math.max(...selected.map((row) => row.statusExpiresAt)),
  });
  const removedBytes = selected.reduce(
    (total, row) => total + row.sizeBytes,
    0,
  );
  await ctx.db.patch(coordinator._id, {
    queuedCount: Math.max(0, queue.queuedCount - selected.length),
    queuedBytes: Math.max(0, queue.queuedBytes - removedBytes),
    leaseExpiresAt: now + args.leaseTtlMs,
    updatedAt: now,
  });

  return {
    eventId: args.ownerEventId,
    events: selected.flatMap((row) => row.events),
    delivery: selected[0]!.delivery,
    requestedMode: "steer" as const,
    appliedMode: "steer" as const,
    appliedToEventId: args.ownerEventId,
    contributingEventIds: eventIds,
    ownerGeneration: args.ownerGeneration,
  };
}

function ingressStatusResult(
  row: Doc<"runtimeIngressEnvelopes">,
): Infer<typeof ingressStatusResultValidator> {
  const publicDeploymentIngress = publicDeploymentIngressFromDelivery(
    row.delivery,
  );

  return {
    eventId: row.eventId,
    runId: row.runId,
    agentId: row.agentId,
    conversationKey: row.conversationKey,
    requestedMode: row.requestedMode,
    ...(row.appliedMode !== undefined ? { appliedMode: row.appliedMode } : {}),
    ...(row.appliedToEventId !== undefined
      ? { appliedToEventId: row.appliedToEventId }
      : {}),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    ...(row.error !== undefined ? { error: row.error } : {}),
    ...(row.stoppedByUser ? { stoppedByUser: true } : {}),
    ...(row.result !== undefined ? { result: row.result } : {}),
    ...(publicDeploymentIngress
      ? { publicDeploymentIngress: publicDeploymentIngress }
      : {}),
  };
}

async function insertOwnedEvents(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  events: Infer<typeof conversationEventsValidator>,
): Promise<void> {
  await requireActiveAccount(ctx, coordinator.accountId);
  await insertConversationEvents(
    ctx,
    coordinator.accountId,
    coordinator.conversationKey,
    events,
  );
}

// Events are stored as `v.any()`, so the model message shape is read at run time.
function isPlainUserText(event: unknown): boolean {
  if (
    typeof event !== "object" ||
    event === null ||
    !("role" in event) ||
    event.role !== "user" ||
    !("content" in event)
  ) {
    return false;
  }
  const content = event.content;

  return (
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.every(
        (part: unknown): boolean =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text",
      ))
  );
}

// Also split on the sender, so one turn never runs two people's messages.
function contiguousModePrefix(
  rows: Doc<"runtimeIngressEnvelopes">[],
  sender: Infer<typeof ingressDeliveryValidator> | undefined = rows[0]
    ?.delivery,
): Doc<"runtimeIngressEnvelopes">[] {
  if (rows.length === 0) return [];
  const senderUserId = deliverySenderUserId(sender);
  const end = rows.findIndex(
    (row): boolean =>
      row.requestedMode !== rows[0]!.requestedMode ||
      deliverySenderUserId(row.delivery) !== senderUserId,
  );

  return end === -1 ? rows : rows.slice(0, end);
}

function deliverySenderUserId(
  delivery: Infer<typeof ingressDeliveryValidator> | undefined,
): string | undefined {
  return delivery?.kind === "channel" ? delivery.identity?.userId : undefined;
}

async function createCoordinator(
  ctx: MutationCtx,
  options: {
    accountId: Id<"accounts">;
    agentId: string;
    conversationKey: string;
    now: number;
  },
): Promise<Doc<"runtimeConversationCoordinators">> {
  const id = await ctx.db.insert("runtimeConversationCoordinators", {
    accountId: options.accountId,
    agentId: options.agentId,
    conversationKey: options.conversationKey,
    nextSequence: 1,
    ownerGeneration: 0,
    queuedCount: 0,
    queuedBytes: 0,
    updatedAt: options.now,
  });

  return (await ctx.db.get(id))!;
}

async function expireQueuedEnvelopes(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  now: number,
  rows?: Doc<"runtimeIngressEnvelopes">[],
): Promise<{ queuedCount: number; queuedBytes: number }> {
  const page = rows ?? (await queuedPage(ctx, coordinator));
  let expiredCount = 0;
  let expiredBytes = 0;
  for (const row of page) {
    if (row.expiresAt > now) continue;
    expiredCount += 1;
    expiredBytes += row.sizeBytes;
    await ctx.db.patch(row._id, {
      ...RELEASED_PAYLOAD,
      status: "expired",
      error: "Ingress expired before it reached a runnable boundary",
      updatedAt: now,
    });
  }

  return {
    queuedCount: Math.max(0, coordinator.queuedCount - expiredCount),
    queuedBytes: Math.max(0, coordinator.queuedBytes - expiredBytes),
  };
}

async function expireStaleOwner(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  now: number,
): Promise<void> {
  if (!coordinator.ownerEventId || hasActiveOwner(coordinator, now)) return;
  const envelope = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_eventId", (q) => q.eq("eventId", coordinator.ownerEventId!))
    .unique();
  if (
    envelope &&
    envelope.conversationKey === coordinator.conversationKey &&
    !["completed", "failed", "expired"].includes(envelope.status)
  ) {
    await ctx.db.patch(envelope._id, {
      ...RELEASED_PAYLOAD,
      status: "expired",
      error: "Conversation owner lease expired before completion",
      updatedAt: now,
    });
  }
}

async function getCoordinator(
  ctx: QueryCtx | MutationCtx,
  conversationKey: string,
): Promise<Doc<"runtimeConversationCoordinators"> | null> {
  return await ctx.db
    .query("runtimeConversationCoordinators")
    .withIndex("by_conversationKey", (q) =>
      q.eq("conversationKey", conversationKey),
    )
    .unique();
}

// A lease ending this millisecond is still live; the fence and every expiry agree on it.
function hasActiveOwner(
  coordinator: Doc<"runtimeConversationCoordinators">,
  now: number,
): coordinator is Doc<"runtimeConversationCoordinators"> & {
  ownerEventId: string;
  leaseExpiresAt: number;
} {
  return Boolean(
    coordinator.ownerEventId &&
    coordinator.leaseExpiresAt &&
    coordinator.leaseExpiresAt >= now,
  );
}

function isLateControl(
  args: { activeOwnerOnly?: boolean; expectedOwnerTaskId?: string },
  coordinator: Doc<"runtimeConversationCoordinators">,
  now: number,
): boolean {
  if (args.activeOwnerOnly !== true) return false;
  if (!hasActiveOwner(coordinator, now)) return true;

  return (
    args.expectedOwnerTaskId !== undefined &&
    coordinator.ownerTaskId !== args.expectedOwnerTaskId
  );
}

async function markDeliveredResultsStored(
  ctx: MutationCtx,
  envelope: Pick<
    Doc<"runtimeIngressEnvelopes">,
    "accountId" | "resultEventId" | "toolResultId"
  >,
): Promise<void> {
  await markResultStored(
    ctx,
    envelope.accountId,
    await asyncAgentResultRow(ctx, envelope.resultEventId),
  );
  await markResultStored(
    ctx,
    envelope.accountId,
    await asyncToolResultRow(ctx, envelope.toolResultId),
  );
}

function resumesSameResult(
  envelope: Pick<
    Doc<"runtimeIngressEnvelopes">,
    "resultEventId" | "toolResultId"
  >,
  args: { resultEventId?: string; toolResultId?: string },
): boolean {
  return (
    (args.resultEventId !== undefined &&
      envelope.resultEventId === args.resultEventId) ||
    (args.toolResultId !== undefined &&
      envelope.toolResultId === args.toolResultId)
  );
}

async function prepareAdmissionCoordinator(
  ctx: MutationCtx,
  args: {
    accountId: Id<"accounts">;
    agentId: string;
    conversationKey: string;
    channelTarget?: Infer<typeof channelTargetValidator>;
  },
  now: number,
): Promise<{
  coordinator: Doc<"runtimeConversationCoordinators">;
  queue: { queuedCount: number; queuedBytes: number };
  rows: Doc<"runtimeIngressEnvelopes">[];
}> {
  let coordinator =
    (await getCoordinator(ctx, args.conversationKey)) ??
    (await createCoordinator(ctx, {
      accountId: args.accountId,
      agentId: args.agentId,
      conversationKey: args.conversationKey,
      now: now,
    }));
  if (
    coordinator.accountId !== args.accountId ||
    coordinator.agentId !== args.agentId
  ) {
    throw new Error("Conversation coordinator scope mismatch");
  }
  if (args.channelTarget !== undefined) {
    await ctx.db.patch(coordinator._id, {
      channelTarget: args.channelTarget,
      updatedAt: now,
    });
    coordinator = {
      ...coordinator,
      channelTarget: args.channelTarget,
      updatedAt: now,
    };
  }
  const rows = await queuedPage(ctx, coordinator);
  const queue = await expireQueuedEnvelopes(ctx, coordinator, now, rows);
  await expireStaleOwner(ctx, coordinator, now);
  coordinator = await patchQueueCounters(ctx, coordinator, queue, now);

  return { coordinator: coordinator, queue: queue, rows: rows };
}

async function promoteQueuedGroup(
  ctx: MutationCtx,
  options: {
    coordinator: Doc<"runtimeConversationCoordinators">;
    queue: { queuedCount: number; queuedBytes: number };
    rows?: Doc<"runtimeIngressEnvelopes">[];
    now: number;
    leaseTtlMs: number;
    ownerGeneration: number;
  },
): Promise<Infer<typeof appliedEnvelopeValidator> | null> {
  const { coordinator, queue, now } = options;
  const rows = options.rows ?? (await queuedPage(ctx, coordinator));
  const active = rows.filter((row) => row.expiresAt > now);
  const first = active[0];
  if (!first) return null;
  // Every queued steer aimed at the same dead run, so their prefix runs as one follow-up.
  const batchable =
    first.requestedMode === "collect" || first.requestedMode === "steer";
  const selected = batchable ? contiguousModePrefix(active) : [first];
  const appliedMode: "collect" | "followup" =
    first.requestedMode === "collect" ? "collect" : "followup";
  const appliedToEventId = first.eventId;
  const eventIds = selected.map((row) => row.eventId);
  const applicationId = `${appliedToEventId}:${appliedMode}:${options.ownerGeneration}:${first.sequence}`;
  for (const row of selected) {
    await markDeliveredResultsStored(ctx, row);
    await ctx.db.patch(row._id, {
      status: "processing",
      appliedMode: appliedMode,
      appliedToEventId: appliedToEventId,
      applicationId: applicationId,
      ownerGeneration: options.ownerGeneration,
      updatedAt: now,
    });
  }
  await ctx.db.insert("runtimeIngressApplications", {
    accountId: coordinator.accountId,
    conversationKey: coordinator.conversationKey,
    applicationId: applicationId,
    appliedMode: appliedMode,
    appliedToEventId: appliedToEventId,
    contributingEventIds: eventIds,
    ownerGeneration: options.ownerGeneration,
    createdAt: now,
    expiresAt: Math.max(...selected.map((row) => row.statusExpiresAt)),
  });
  const removedBytes = selected.reduce(
    (total, row) => total + row.sizeBytes,
    0,
  );
  await ctx.db.patch(coordinator._id, {
    ownerEventId: appliedToEventId,
    ownerTaskId: first.ownerTaskId,
    ownerGeneration: options.ownerGeneration,
    stopRequestedGeneration: undefined,
    queuedCount: Math.max(0, queue.queuedCount - selected.length),
    queuedBytes: Math.max(0, queue.queuedBytes - removedBytes),
    leaseExpiresAt: now + options.leaseTtlMs,
    updatedAt: now,
  });

  return {
    eventId: appliedToEventId,
    events: selected.flatMap((row) => row.events),
    delivery: first.delivery,
    requestedMode: first.requestedMode,
    appliedMode: appliedMode,
    appliedToEventId: appliedToEventId,
    contributingEventIds: eventIds,
    ownerGeneration: options.ownerGeneration,
    ...(first.configRef !== undefined ? { configRef: first.configRef } : {}),
    ...(first.ephemeralSystem !== undefined
      ? { ephemeralSystem: first.ephemeralSystem }
      : {}),
  };
}

function publicDeploymentIngressFromDelivery(
  delivery: Infer<typeof ingressDeliveryValidator>,
): PublicDeploymentIngress | undefined {
  if (delivery.kind === "channel") return undefined;

  return delivery.publicDeploymentIngress;
}

async function patchQueueCounters(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  queue: { queuedCount: number; queuedBytes: number },
  now: number,
  lease?: { leaseExpiresAt: number },
): Promise<Doc<"runtimeConversationCoordinators">> {
  if (
    queue.queuedCount === coordinator.queuedCount &&
    queue.queuedBytes === coordinator.queuedBytes
  ) {
    return coordinator;
  }
  const patch = { ...queue, ...lease, updatedAt: now };
  await ctx.db.patch(coordinator._id, patch);

  return { ...coordinator, ...patch };
}

async function queuedEnvelopes(
  ctx: MutationCtx,
  conversationKey: string,
): Promise<Doc<"runtimeIngressEnvelopes">[]> {
  return await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
      q.eq("conversationKey", conversationKey).eq("status", "queued"),
    )
    .take(MAX_DRAIN_ENVELOPES);
}

// Every move into or out of `queued` adjusts queuedCount in its transaction: 0 is empty.
async function queuedPage(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
): Promise<Doc<"runtimeIngressEnvelopes">[]> {
  if (coordinator.queuedCount === 0) return [];

  return await queuedEnvelopes(ctx, coordinator.conversationKey);
}

// Core renews every second; a no-op on a fresh lease does not invalidate `isCurrentOwner`.
async function renewHeldLease(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  leaseTtlMs: number,
  now: number,
): Promise<void> {
  const remainingMs = (coordinator.leaseExpiresAt ?? 0) - now;
  if (remainingMs > leaseTtlMs * RENEW_AFTER_TTL_FRACTION) return;
  await ctx.db.patch(coordinator._id, {
    leaseExpiresAt: now + leaseTtlMs,
    updatedAt: now,
  });
}

async function requireOwner(
  ctx: QueryCtx | MutationCtx,
  options: {
    conversationKey: string;
    ownerEventId: string;
    ownerGeneration: number;
    now?: number;
  },
): Promise<Doc<"runtimeConversationCoordinators">> {
  const coordinator = await getCoordinator(ctx, options.conversationKey);
  const now = options.now ?? Date.now();
  if (
    !coordinator ||
    coordinator.ownerEventId !== options.ownerEventId ||
    coordinator.ownerGeneration !== options.ownerGeneration ||
    !hasActiveOwner(coordinator, now)
  ) {
    throw new Error("Stale conversation owner generation");
  }

  return coordinator;
}

async function settleAppliedEnvelopes(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  args: {
    conversationKey: string;
    ownerEventId: string;
    ownerGeneration: number;
    status: "completed" | "failed";
    result?: unknown;
    error?: string;
  },
): Promise<{ count: number; ownerFinished: boolean }> {
  const now = Date.now();
  const stoppedByUser =
    args.status === "failed" &&
    coordinator.stopRequestedGeneration === args.ownerGeneration &&
    coordinator.stopRequestedByParent !== true;
  const ids = new Set<Id<"runtimeIngressEnvelopes">>();
  let afterSequence = -1;
  for (;;) {
    const rows = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_conversationKey_and_appliedToEventId_and_sequence", (q) =>
        q
          .eq("conversationKey", args.conversationKey)
          .eq("appliedToEventId", args.ownerEventId)
          .gt("sequence", afterSequence),
      )
      .take(MAX_DRAIN_ENVELOPES);
    for (const row of rows) ids.add(row._id);
    if (rows.length < MAX_DRAIN_ENVELOPES) break;
    afterSequence = rows[rows.length - 1]!.sequence;
  }
  const own = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_eventId", (q) => q.eq("eventId", args.ownerEventId))
    .unique();
  if (own?.conversationKey === args.conversationKey) ids.add(own._id);
  let ownerFinished = false;
  for (const id of ids) {
    const row = await ctx.db.get(id);
    if (row?.status !== "processing") continue;
    await ctx.db.patch(id, {
      ...RELEASED_PAYLOAD,
      status: args.status,
      updatedAt: now,
      ...(stoppedByUser ? { stoppedByUser: true } : {}),
      ...(args.result !== undefined ? { result: args.result } : {}),
      ...(args.error !== undefined ? { error: args.error } : {}),
    });
    if (id === own?._id) ownerFinished = true;
  }

  return { count: ids.size, ownerFinished: ownerFinished };
}
