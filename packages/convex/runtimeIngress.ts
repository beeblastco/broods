/**
 * Durable FIFO ingress, fenced conversation ownership, and pollable status.
 * Transport parsing stays in core; this module owns atomic admission and state transitions.
 */

import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { isPlainObject } from "./model/objects";
import {
  asyncAgentOutcomeValidator,
  conversationEventsValidator,
  writeAsyncAgentResult,
} from "./runtime";
import {
  channelTargetRefsFields,
  ingressConfigRefValidator,
  ingressModeValidator,
  ingressStatusValidator,
} from "./schema";
import { accountIdFromKey, requireActiveAccount } from "./model/activeAccount";

const CLEAR_BATCH_SIZE = 100;

// Statuses maintenance may still expire. Terminal rows (completed/failed/
// expired) are excluded at the index, not filtered after the read: they retain
// their stale expiresAt for the whole status retention window, and scanning
// them every sweep re-reads every retained payload.
// `accepted` and `applied` exist only in the public status type; no envelope
// row is ever written with them.
const EXPIRABLE_STATUSES = ["queued", "processing"] as const;

const MAX_DRAIN_ENVELOPES = 100;

// `renewOwner` skips the write while more than this fraction of the TTL remains.
const RENEW_AFTER_TTL_FRACTION = 0.9;

// Statuses whose rows only await retention deletion; scanned by their own
// index so the sweep never touches a row it is not about to delete.
const TERMINAL_STATUSES = ["completed", "failed", "expired"] as const;

// Spread into every terminal patch. Nothing reads a settled row's payload
// (duplicate replay compares `payloadDigest`), so it should not sit in the
// table for the whole status retention window.
const RELEASED_PAYLOAD = {
  events: [],
  configRef: undefined,
  ephemeralSystem: undefined,
};

// appliedEnvelopeValidator stays ahead of admissionResultValidator, which embeds it.
const appliedEnvelopeValidator = v.object({
  eventId: v.string(),
  events: v.array(v.any()),
  delivery: v.any(),
  requestedMode: ingressModeValidator,
  appliedMode: ingressModeValidator,
  appliedToEventId: v.string(),
  contributingEventIds: v.array(v.string()),
  ownerGeneration: v.number(),
  configRef: v.optional(ingressConfigRefValidator),
  ephemeralSystem: v.optional(v.array(v.any())),
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
  // The run's own id. On a duplicate this is the first admission's, not the
  // one the retry minted, so an idempotent POST keeps one run id.
  runId: v.optional(v.string()),
  status: v.optional(ingressStatusValidator),
  ownerGeneration: v.optional(v.number()),
  sequence: v.optional(v.number()),
  // Present when admission recovered an expired owner by promoting the oldest
  // queued envelope; the caller must schedule this recovered application.
  recovered: v.optional(appliedEnvelopeValidator),
});

const recoveredIngressValidator = v.object({
  accountId: v.id("accounts"),
  agentId: v.string(),
  conversationKey: v.string(),
  applied: appliedEnvelopeValidator,
});

// What a channel session keeps so a cron, background job or inter-session
// message can reach it again: the place, and the rows core rebuilds the run's
// config from. Never the config itself, which holds decrypted secrets.
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
  publicDeploymentIngress: v.optional(
    v.object({
      accountId: v.string(),
      endpointId: v.string(),
      stageSlug: v.string(),
      projectSlug: v.string(),
    }),
  ),
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

// The part of a channel delivery that names who sent the message.
type DeliverySender = { identity?: { userId?: string } } | null | undefined;

type PublicDeploymentIngress = {
  accountId: string;
  endpointId: string;
  stageSlug: string;
  projectSlug: string;
};

/**
 * Atomically admits an ingress candidate, binds idempotency, and either owns or queues it.
 * Rejected busy candidates create neither an envelope nor an identity tombstone.
 */
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
    delivery: v.any(),
    requestedMode: ingressModeValidator,
    configRef: v.optional(ingressConfigRefValidator),
    channelTarget: v.optional(channelTargetValidator),
    ephemeralSystem: v.optional(v.array(v.any())),
    sizeBytes: v.number(),
    leaseTtlMs: v.number(),
    envelopeTtlMs: v.number(),
    statusTtlMs: v.number(),
    maxQueuedCount: v.number(),
    maxQueuedBytes: v.number(),
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
    // Fenced before recovery: a late control must not claim the owner slot
    // that recovery is about to hand to already-queued work.
    const lateControl = isLateControl(args, coordinator, now);

    // Durable FIFO recovery: when the owner lease expired with work still
    // queued, the oldest queued group must run before this new arrival.
    let recovered: Awaited<ReturnType<typeof promoteQueuedGroup>> = null;
    if (!hasActiveOwner(coordinator, now) && queue.queuedCount > 0) {
      recovered = await promoteQueuedGroup(ctx, {
        coordinator: coordinator,
        queue: queue,
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

/** Acquires a fenced clear lease only when no run or queued ingress exists. */
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
    if (hasActiveOwner(coordinator, now) || queue.queuedCount > 0) return null;
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

/** Appends history events only for the current fenced owner, all or none. */
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

/**
 * Applies the contiguous FIFO steer prefix at one step boundary. Claims nothing
 * once a stop is requested for this generation, so a stop that lands after
 * core's renew leaves the steer queued for the next turn.
 */
export const applySteering = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    leaseTtlMs: v.number(),
    // A harness turn takes a steer only as text: claim the plain-text prefix
    // and leave the rest queued for the next turn.
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

/** Clears one bounded history batch while the caller holds the clear lease. */
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

/** Returns the durable channel destination for one existing agent session. */
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

/** Reads one status only when account and agent authorization match its envelope. */
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
    // Account-scoped at the index, so a guessed run id cannot read across
    // accounts and the agent comes off the row rather than the query string.
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

/**
 * Reads one run's status by its scoped event id, re-checking the account and
 * agent the caller named. Only the subagent-parent authorization check uses
 * this: it knows the parent's scoped id but not the parent's run id.
 */
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

/** Checks whether the supplied owner generation is still current and unexpired. */
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

/** Expires abandoned work and removes status/idempotency rows after retention. */
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
        // The owner is alive. Move the row off the head of the due range, or
        // 100 long runs would fill every batch and starve real expiries.
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

    // A full batch means a backlog the fixed cadence cannot drain; keep
    // sweeping immediately until every range comes back short.
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
 * Promotes the oldest queued group of each conversation that has queued work
 * but no live owner. Admission already recovers a conversation when its next
 * message arrives; this is for the ones nobody writes to again, such as the
 * queue behind a run that core handed back at shutdown. Core calls it on boot
 * and on a timer, then dispatches every returned application, whose lease it
 * now holds.
 *
 * Steps through queued conversations in key order, one index read each, so a
 * conversation with a long queue behind a live owner costs no more than any
 * other. Bounded like maintain: `continueAfter` is the last conversation this
 * page looked at, for the caller's next page, or null when none remain.
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
      const queue = await expireQueuedEnvelopes(ctx, coordinator, now);
      const applied = await promoteQueuedGroup(ctx, {
        coordinator: coordinator,
        queue: queue,
        now: now,
        leaseTtlMs: args.leaseTtlMs,
        ownerGeneration: coordinator.ownerGeneration + 1,
      });
      if (!applied) continue;
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

/** Releases ownership only when the caller still holds the current generation. */
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

/** Renews the current owner or reports its generation-scoped stop request. */
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

/**
 * Settles every envelope whose work was applied to the current owner event.
 * An async run passes its polling rows as `asyncResult`; they are written in
 * the same transaction, and only by the settle that finishes the owner's own
 * envelope, so they can never disagree with it.
 */
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
  },
  returns: v.number(),
  handler: async (ctx, args): Promise<number> => {
    const coordinator = await requireOwner(ctx, args);
    const settled = await settleAppliedEnvelopes(ctx, coordinator, args);
    if (args.asyncResult && settled.ownerFinished) {
      for (const eventId of args.asyncResult.eventIds) {
        await writeAsyncAgentResult(ctx, eventId, args.asyncResult.outcome);
      }
    }

    return settled.count;
  },
});

/**
 * One model step boundary in one transaction: the fenced append of the step's
 * rows, the stop check, the lease renewal, and the steer claim. A stale owner
 * writes nothing. A stop keeps the rows, as `renewOwner` beside a fenced append
 * did, and claims no steer. `claimSteering: false` leaves steers queued for the
 * next run, as a run winding down before its deadline asks.
 */
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

/** Requests a boundary stop for the current generation; queued work is untouched. */
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
      updatedAt: now,
    });

    return { stopped: true, queuedCount: coordinator.queuedCount };
  },
});

/**
 * Applies the oldest runnable group, or releases ownership when none remains.
 * With `settle`, first settles the owner's envelopes in the same transaction.
 */
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
  },
  returns: v.union(appliedEnvelopeValidator, v.null()),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof appliedEnvelopeValidator> | null> => {
    const now = Date.now();
    const coordinator = await requireOwner(ctx, { ...args, now: now });
    if (args.settle) {
      await settleAppliedEnvelopes(ctx, coordinator, {
        ...args,
        ...args.settle,
      });
    }
    const queue = await expireQueuedEnvelopes(ctx, coordinator, now);
    const promoted = await promoteQueuedGroup(ctx, {
      coordinator: coordinator,
      queue: queue,
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

/** Verifies that server-derived account and agent scope match the conversation key. */
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

/** The envelope fields shared by the queued and owner insert paths of `accept`. */
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
    delivery: unknown;
    requestedMode: Infer<typeof ingressModeValidator>;
    ownerTaskId?: string;
    configRef?: Infer<typeof ingressConfigRefValidator>;
    ephemeralSystem?: unknown[];
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
    sizeBytes: args.sizeBytes,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + args.envelopeTtlMs,
    statusExpiresAt: now + args.statusTtlMs,
  };
}

/** Hashes the one canonical tenant/agent/conversation idempotency identity. */
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

/**
 * Idempotency check for `accept`: an identity match replays its prior
 * admission (or conflicts on a different payload digest), and an eventId
 * reused under a different identity is always a conflict. Null means the
 * candidate is new. Rejected busy candidates create neither an envelope nor
 * an identity tombstone, so this is read-only.
 */
async function checkDuplicateAdmission(
  ctx: MutationCtx,
  args: { eventId: string; payloadDigest: string },
  identity: string,
): Promise<Infer<typeof admissionResultValidator> | null> {
  const existing = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_identity", (q) => q.eq("identity", identity))
    .unique();
  if (existing) {
    if (existing.payloadDigest !== args.payloadDigest) {
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

  return null;
}

/**
 * `applySteering`'s body once the fence passed; `stepBoundary` runs it too.
 * Claims nothing once a stop is requested for this generation.
 */
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
  if (coordinator.stopRequestedGeneration === args.ownerGeneration) {
    return null;
  }
  const queue = await expireQueuedEnvelopes(ctx, coordinator, now);
  const rows = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
      q.eq("conversationKey", args.conversationKey).eq("status", "queued"),
    )
    .take(MAX_DRAIN_ENVELOPES);
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
    if (
      queue.queuedCount !== coordinator.queuedCount ||
      queue.queuedBytes !== coordinator.queuedBytes
    ) {
      await ctx.db.patch(coordinator._id, {
        ...queue,
        leaseExpiresAt: now + args.leaseTtlMs,
        updatedAt: now,
      });
    }

    return null;
  }
  const eventIds = selected.map((row) => row.eventId);
  const applicationId = `${args.ownerEventId}:steer:${args.ownerGeneration}:${selected[0]!.sequence}`;
  for (const row of selected) {
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

/** One envelope row as the status shape the public status route answers with. */
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

/** Inserts history rows for an owner the fence just accepted, all or none. */
async function insertOwnedEvents(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  events: { cursor: string; event: unknown }[],
): Promise<void> {
  await requireActiveAccount(ctx, coordinator.accountId);
  for (const entry of events) {
    await ctx.db.insert("runtimeConversationEvents", {
      accountId: coordinator.accountId,
      conversationKey: coordinator.conversationKey,
      cursor: entry.cursor,
      event: entry.event,
    });
  }
}

/**
 * Whether a stored ingress event is a user message made only of text. Events
 * are stored as `v.any()`, so this reads the model message shape at run time.
 */
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

/**
 * The leading run of rows that share the first row's requestedMode and the
 * sender's userId, so one turn never runs two people's messages.
 */
function contiguousModePrefix(
  rows: Doc<"runtimeIngressEnvelopes">[],
  sender: DeliverySender = rows[0]?.delivery,
): Doc<"runtimeIngressEnvelopes">[] {
  if (rows.length === 0) return [];
  const end = rows.findIndex((row): boolean => {
    const delivery: DeliverySender = row.delivery;

    return (
      row.requestedMode !== rows[0]!.requestedMode ||
      delivery?.identity?.userId !== sender?.identity?.userId
    );
  });

  return end === -1 ? rows : rows.slice(0, end);
}

/** Inserts a new zeroed coordinator when the conversation has no state yet. */
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

/** Marks expired queued work terminal and returns adjusted queue counters. */
async function expireQueuedEnvelopes(
  ctx: MutationCtx,
  coordinator: Doc<"runtimeConversationCoordinators">,
  now: number,
): Promise<{ queuedCount: number; queuedBytes: number }> {
  const rows = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
      q
        .eq("conversationKey", coordinator.conversationKey)
        .eq("status", "queued"),
    )
    .take(MAX_DRAIN_ENVELOPES);
  let expiredCount = 0;
  let expiredBytes = 0;
  for (const row of rows) {
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

/** Marks a crashed owner's nonterminal envelope expired before ownership recovery. */
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

/**
 * Whether the coordinator has an owner whose lease has not ended. A lease that
 * ends this millisecond is still live; the fence and every expiry agree on it.
 */
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

/**
 * An `activeOwnerOnly` admission is late when the conversation has no live
 * owner, or the live owner is not the task the control was aimed at.
 */
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

/**
 * Coordinator stage of `accept`: loads or creates the conversation
 * coordinator, verifies its scope, pins the latest channel target, and
 * reconciles queue counters after expiring stale queued work and a stale
 * owner's envelope. The returned coordinator reflects every patch applied.
 */
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
  const queue = await expireQueuedEnvelopes(ctx, coordinator, now);
  await expireStaleOwner(ctx, coordinator, now);
  if (
    queue.queuedCount !== coordinator.queuedCount ||
    queue.queuedBytes !== coordinator.queuedBytes
  ) {
    await ctx.db.patch(coordinator._id, {
      queuedCount: queue.queuedCount,
      queuedBytes: queue.queuedBytes,
      updatedAt: now,
    });
    coordinator = { ...coordinator, ...queue, updatedAt: now };
  }

  return { coordinator: coordinator, queue: queue };
}

/**
 * Promotes the oldest runnable queued group (one follow-up, or a contiguous
 * collect/steer prefix) to processing under the supplied owner generation.
 */
async function promoteQueuedGroup(
  ctx: MutationCtx,
  options: {
    coordinator: Doc<"runtimeConversationCoordinators">;
    queue: { queuedCount: number; queuedBytes: number };
    now: number;
    leaseTtlMs: number;
    ownerGeneration: number;
  },
): Promise<{
  eventId: string;
  events: unknown[];
  delivery: unknown;
  requestedMode: Doc<"runtimeIngressEnvelopes">["requestedMode"];
  appliedMode: "collect" | "followup";
  appliedToEventId: string;
  contributingEventIds: string[];
  ownerGeneration: number;
  configRef?: Infer<typeof ingressConfigRefValidator>;
  ephemeralSystem?: unknown[];
} | null> {
  const { coordinator, queue, now } = options;
  const rows = await ctx.db
    .query("runtimeIngressEnvelopes")
    .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
      q
        .eq("conversationKey", coordinator.conversationKey)
        .eq("status", "queued"),
    )
    .take(MAX_DRAIN_ENVELOPES);
  const active = rows.filter((row) => row.expiresAt > now);
  const first = active[0];
  if (!first) return null;
  // Collect batches by design; steer batches too. Every queued steer aimed at
  // the same dead run, so a contiguous prefix runs as one merged follow-up.
  const batchable =
    first.requestedMode === "collect" || first.requestedMode === "steer";
  const selected = batchable ? contiguousModePrefix(active) : [first];
  const appliedMode: "collect" | "followup" =
    first.requestedMode === "collect" ? "collect" : "followup";
  const appliedToEventId = first.eventId;
  const eventIds = selected.map((row) => row.eventId);
  const applicationId = `${appliedToEventId}:${appliedMode}:${options.ownerGeneration}:${first.sequence}`;
  for (const row of selected) {
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
  delivery: unknown,
): PublicDeploymentIngress | undefined {
  if (!isPlainObject(delivery)) return undefined;
  const record = delivery;
  if (
    record.kind !== "http" &&
    record.kind !== "async" &&
    record.kind !== "websocket"
  ) {
    return undefined;
  }
  const marker = record.publicDeploymentIngress;
  if (!isPlainObject(marker)) return undefined;
  const value = marker;
  if (
    typeof value.accountId !== "string" ||
    typeof value.endpointId !== "string" ||
    typeof value.stageSlug !== "string" ||
    typeof value.projectSlug !== "string"
  ) {
    return undefined;
  }

  return {
    accountId: value.accountId,
    endpointId: value.endpointId,
    stageSlug: value.stageSlug,
    projectSlug: value.projectSlug,
  };
}

/**
 * Extends a lease the fence just accepted, once a tenth of the TTL has passed.
 * Core renews every second while a harness turn runs, so most renewals stay
 * read-only and do not invalidate `isCurrentOwner` readers.
 */
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

/** Requires the account to exist and remain active in the write transaction. */

/** Requires the exact owner event and fencing generation for a mutation. */
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

/**
 * Marks the owner event and every envelope applied to it terminal; used by
 * `settle` and `takeNext`.
 * @returns how many envelopes it covered, and whether the owner's own envelope
 * finished in this call
 */
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
  // A failed settle that was preceded by /stop for this generation is a
  // deliberate stop, not a fault, so mark it and pollers can tell them apart.
  const stoppedByUser =
    args.status === "failed" &&
    coordinator.stopRequestedGeneration === args.ownerGeneration;
  const ids = new Set<Id<"runtimeIngressEnvelopes">>();
  // Page by sequence so more than one drain batch of contributors still
  // settles; a fixed take() would leave the tail stuck in processing.
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
    // Only running rows settle: a finished run stays finished, and a queued row
    // never ran, so it waits for its own owner or expiry.
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
