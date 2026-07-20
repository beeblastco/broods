/**
 * Durable FIFO ingress, fenced conversation ownership, and pollable status.
 * Transport parsing stays in core; this module owns atomic admission and state transitions.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  appliedIngressModeValidator,
  ingressModeValidator,
  ingressStatusValidator,
} from "./schema";

const MAX_DRAIN_ENVELOPES = 100;
const CLEAR_BATCH_SIZE = 100;

const ownerRenewalResultValidator = v.union(
  v.literal("renewed"),
  v.literal("stopped"),
  v.literal("stale"),
);

const appliedEnvelopeValidator = v.object({
  eventId: v.string(),
  events: v.array(v.any()),
  delivery: v.any(),
  requestedMode: ingressModeValidator,
  appliedMode: appliedIngressModeValidator,
  appliedToEventId: v.string(),
  contributingEventIds: v.array(v.string()),
  ownerGeneration: v.number(),
  agentConfig: v.optional(v.any()),
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
  ),
  eventId: v.optional(v.string()),
  status: v.optional(ingressStatusValidator),
  ownerGeneration: v.optional(v.number()),
  sequence: v.optional(v.number()),
  // Present when admission recovered an expired owner by promoting the oldest
  // queued envelope; the caller must schedule this recovered application.
  recovered: v.optional(appliedEnvelopeValidator),
});

const ingressStatusResultValidator = v.object({
  eventId: v.string(),
  conversationKey: v.string(),
  requestedMode: ingressModeValidator,
  appliedMode: v.optional(appliedIngressModeValidator),
  appliedToEventId: v.optional(v.string()),
  status: ingressStatusValidator,
  createdAt: v.number(),
  updatedAt: v.number(),
  expiresAt: v.number(),
  error: v.optional(v.string()),
  result: v.optional(v.any()),
});

/** Extracts the account ID from an account-scoped runtime key. */
function accountIdFromKey(value: string): string {
  const match = /^acct:([^:]+):/.exec(value);
  if (!match?.[1]) throw new Error("Runtime key is not account scoped");

  return match[1];
}

/** Requires the account to exist and remain active in the write transaction. */
async function requireActiveAccount(
  ctx: MutationCtx,
  accountId: string,
): Promise<void> {
  const normalized = ctx.db.normalizeId("accounts", accountId);
  const account = normalized ? await ctx.db.get(normalized) : null;
  if (!account || account.status !== "active") {
    throw new Error(`Account is not active: ${accountId}`);
  }
}

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

/** Loads the single coordinator row for a conversation. */
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

/** Inserts a new zeroed coordinator when the conversation has no state yet. */
async function createCoordinator(
  ctx: MutationCtx,
  options: {
    accountId: string;
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

/** Returns whether the coordinator currently has an unexpired owner. */
function hasActiveOwner(
  coordinator: Doc<"runtimeConversationCoordinators">,
  now: number,
): boolean {
  return Boolean(
    coordinator.ownerEventId &&
    coordinator.leaseExpiresAt &&
    coordinator.leaseExpiresAt >= now,
  );
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
  if (!coordinator.ownerEventId || !coordinator.leaseExpiresAt) return;
  if (coordinator.leaseExpiresAt >= now) return;
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
      status: "expired",
      error: "Conversation owner lease expired before completion",
      updatedAt: now,
    });
  }
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
  agentConfig?: unknown;
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
  // Collect batches by design; steer batches too — every queued steer aimed at
  // the same dead run, so a contiguous prefix runs as one merged follow-up.
  const batchable =
    first.requestedMode === "collect" || first.requestedMode === "steer";
  const prefixEnd = active.findIndex(
    (row) => row.requestedMode !== first.requestedMode,
  );
  const selected = batchable
    ? active.slice(0, prefixEnd === -1 ? active.length : prefixEnd)
    : [first];
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
    ...(first.agentConfig !== undefined
      ? { agentConfig: first.agentConfig }
      : {}),
    ...(first.ephemeralSystem !== undefined
      ? { ephemeralSystem: first.ephemeralSystem }
      : {}),
  };
}

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
    !coordinator.leaseExpiresAt ||
    coordinator.leaseExpiresAt < now
  ) {
    throw new Error("Stale conversation owner generation");
  }

  return coordinator;
}

/**
 * Atomically admits an ingress candidate, binds idempotency, and either owns or queues it.
 * Rejected busy candidates create neither an envelope nor an identity tombstone.
 */
export const accept = internalMutation({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    conversationKey: v.string(),
    eventId: v.string(),
    idempotencyKey: v.string(),
    payloadDigest: v.string(),
    events: v.array(v.any()),
    delivery: v.any(),
    requestedMode: ingressModeValidator,
    agentConfig: v.optional(v.any()),
    ephemeralSystem: v.optional(v.array(v.any())),
    sizeBytes: v.number(),
    leaseTtlMs: v.number(),
    envelopeTtlMs: v.number(),
    statusTtlMs: v.number(),
    maxQueuedCount: v.number(),
    maxQueuedBytes: v.number(),
  },
  returns: admissionResultValidator,
  handler: async (ctx, args) => {
    await requireActiveAccount(ctx, args.accountId);
    assertConversationScope(args.accountId, args.agentId, args.conversationKey);
    if (args.sizeBytes < 0)
      throw new Error("Ingress size must not be negative");
    const now = Date.now();
    const identity = await canonicalIdentity(args);
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

    const busy = hasActiveOwner(coordinator, now);
    if (busy && args.requestedMode === "reject") {
      return {
        outcome: "rejected" as const,
        ...(recovered ? { recovered } : {}),
      };
    }
    if (
      busy &&
      (coordinator.queuedCount >= args.maxQueuedCount ||
        coordinator.queuedBytes + args.sizeBytes > args.maxQueuedBytes)
    ) {
      return {
        outcome: "capacity" as const,
        ...(recovered ? { recovered } : {}),
      };
    }

    const sequence = coordinator.nextSequence;
    const baseEnvelope = {
      accountId: args.accountId,
      agentId: args.agentId,
      conversationKey: args.conversationKey,
      sequence: sequence,
      eventId: args.eventId,
      identity: identity,
      idempotencyKey: args.idempotencyKey,
      payloadDigest: args.payloadDigest,
      events: args.events,
      delivery: args.delivery,
      requestedMode: args.requestedMode,
      ...(args.agentConfig !== undefined
        ? { agentConfig: args.agentConfig }
        : {}),
      ...(args.ephemeralSystem !== undefined
        ? { ephemeralSystem: args.ephemeralSystem }
        : {}),
      sizeBytes: args.sizeBytes,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + args.envelopeTtlMs,
      statusExpiresAt: now + args.statusTtlMs,
    };
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
        status: "queued" as const,
        sequence: sequence,
        ...(recovered ? { recovered } : {}),
      };
    }

    const ownerGeneration = coordinator.ownerGeneration + 1;
    const appliedMode =
      args.requestedMode === "steer" ? "followup" : args.requestedMode;
    await ctx.db.insert("runtimeIngressEnvelopes", {
      ...baseEnvelope,
      appliedMode,
      appliedToEventId: args.eventId,
      ownerGeneration: ownerGeneration,
      status: "processing",
    });
    await ctx.db.patch(coordinator._id, {
      nextSequence: sequence + 1,
      ownerGeneration: ownerGeneration,
      ownerEventId: args.eventId,
      stopRequestedGeneration: undefined,
      leaseExpiresAt: now + args.leaseTtlMs,
      updatedAt: now,
    });

    return {
      outcome: "owner" as const,
      eventId: args.eventId,
      status: "processing" as const,
      ownerGeneration: ownerGeneration,
      sequence: sequence,
    };
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
  handler: async (ctx, args) => {
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
    await ctx.db.patch(coordinator._id, {
      leaseExpiresAt: now + args.leaseTtlMs,
      updatedAt: now,
    });

    return "renewed" as const;
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
  handler: async (ctx, args) => {
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

/** Checks whether the supplied owner generation is still current and unexpired. */
export const isCurrentOwner = internalQuery({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    try {
      await requireOwner(ctx, args);
      return true;
    } catch {
      return false;
    }
  },
});

/** Appends one history event only for the current fenced owner. */
export const appendConversationEvent = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    cursor: v.string(),
    event: v.any(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const coordinator = await requireOwner(ctx, args);
    await requireActiveAccount(ctx, coordinator.accountId);
    await ctx.db.insert("runtimeConversationEvents", {
      accountId: coordinator.accountId,
      conversationKey: args.conversationKey,
      cursor: args.cursor,
      event: args.event,
    });

    return null;
  },
});

/** Applies the contiguous FIFO steer prefix at one step boundary. */
export const applySteering = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    leaseTtlMs: v.number(),
  },
  returns: v.union(appliedEnvelopeValidator, v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    const coordinator = await requireOwner(ctx, { ...args, now: now });
    const queue = await expireQueuedEnvelopes(ctx, coordinator, now);
    const rows = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_conversationKey_and_status_and_sequence", (q) =>
        q.eq("conversationKey", args.conversationKey).eq("status", "queued"),
      )
      .take(MAX_DRAIN_ENVELOPES);
    const active = rows.filter((row) => row.expiresAt > now);
    const prefixEnd = active.findIndex((row) => row.requestedMode !== "steer");
    const selected =
      active[0]?.requestedMode === "steer"
        ? active.slice(0, prefixEnd === -1 ? active.length : prefixEnd)
        : [];
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
  },
});

/** Applies the oldest runnable follow-up or contiguous collect/steer group. */
export const takeNext = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    leaseTtlMs: v.number(),
  },
  returns: v.union(appliedEnvelopeValidator, v.null()),
  handler: async (ctx, args) => {
    const now = Date.now();
    const coordinator = await requireOwner(ctx, { ...args, now: now });
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
        leaseExpiresAt: now + args.leaseTtlMs,
        updatedAt: now,
      });
      return null;
    }

    return promoted;
  },
});

/** Settles every envelope whose work was applied to the current owner event. */
export const settle = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
    status: v.union(v.literal("completed"), v.literal("failed")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireOwner(ctx, args);
    const now = Date.now();
    const ids = new Set<Id<"runtimeIngressEnvelopes">>();
    // Page by sequence so more than one drain batch of contributors still
    // settles; a fixed take() would leave the tail stuck in processing.
    let afterSequence = -1;
    while (true) {
      const rows = await ctx.db
        .query("runtimeIngressEnvelopes")
        .withIndex(
          "by_conversationKey_and_appliedToEventId_and_sequence",
          (q) =>
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
    for (const id of ids) {
      const row = await ctx.db.get(id);
      if (!row || ["completed", "failed", "expired"].includes(row.status))
        continue;
      await ctx.db.patch(id, {
        status: args.status,
        updatedAt: now,
        ...(args.result !== undefined ? { result: args.result } : {}),
        ...(args.error !== undefined ? { error: args.error } : {}),
      });
    }

    return ids.size;
  },
});

/** Reads one status only when account and agent authorization match its envelope. */
export const getStatus = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    eventId: v.string(),
  },
  returns: v.union(ingressStatusResultValidator, v.null()),
  handler: async (ctx, args) => {
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

    return {
      eventId: row.eventId,
      conversationKey: row.conversationKey,
      requestedMode: row.requestedMode,
      ...(row.appliedMode !== undefined
        ? { appliedMode: row.appliedMode }
        : {}),
      ...(row.appliedToEventId !== undefined
        ? { appliedToEventId: row.appliedToEventId }
        : {}),
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt,
      ...(row.error !== undefined ? { error: row.error } : {}),
      ...(row.result !== undefined ? { result: row.result } : {}),
    };
  },
});

/** Requests a boundary stop for the current generation; queued work is untouched. */
export const stopOwner = internalMutation({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
    conversationKey: v.string(),
  },
  returns: v.object({ stopped: v.boolean(), queuedCount: v.number() }),
  handler: async (ctx, args) => {
    await requireActiveAccount(ctx, args.accountId);
    assertConversationScope(args.accountId, args.agentId, args.conversationKey);
    const now = Date.now();
    const coordinator = await getCoordinator(ctx, args.conversationKey);
    if (!coordinator || !hasActiveOwner(coordinator, now)) {
      return { stopped: false, queuedCount: coordinator?.queuedCount ?? 0 };
    }
    await ctx.db.patch(coordinator._id, {
      stopRequestedGeneration: coordinator.ownerGeneration,
      updatedAt: now,
    });

    return { stopped: true, queuedCount: coordinator.queuedCount };
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
  handler: async (ctx, args) => {
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

/** Clears one bounded history batch while the caller holds the clear lease. */
export const clearConversation = internalMutation({
  args: {
    conversationKey: v.string(),
    ownerEventId: v.string(),
    ownerGeneration: v.number(),
  },
  returns: v.object({ deleted: v.number(), hasMore: v.boolean() }),
  handler: async (ctx, args) => {
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

    return {
      deleted: batch.length,
      hasMore: rows.length > CLEAR_BATCH_SIZE,
    };
  },
});

/** Expires abandoned work and removes status/idempotency rows after retention. */
export const maintain = internalMutation({
  args: {},
  returns: v.object({ expired: v.number(), deleted: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    // Filter inside the query: retained terminal rows share this index, and a
    // plain take() would let 100 of them pin overdue nonterminal work forever.
    const due = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .filter((q) =>
        q.and(
          q.neq(q.field("status"), "completed"),
          q.neq(q.field("status"), "failed"),
          q.neq(q.field("status"), "expired"),
        ),
      )
      .take(MAX_DRAIN_ENVELOPES);
    let expired = 0;
    for (const row of due) {
      if (["completed", "failed", "expired"].includes(row.status)) continue;
      const coordinator = await getCoordinator(ctx, row.conversationKey);
      if (
        row.status === "processing" &&
        coordinator?.leaseExpiresAt &&
        coordinator.leaseExpiresAt > now
      ) {
        continue;
      }
      await ctx.db.patch(row._id, {
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
        coordinator.leaseExpiresAt !== undefined &&
        coordinator.leaseExpiresAt <= now
      ) {
        await ctx.db.patch(coordinator._id, {
          ownerEventId: undefined,
          leaseExpiresAt: undefined,
          updatedAt: now,
        });
      }
    }

    const retained = await ctx.db
      .query("runtimeIngressEnvelopes")
      .withIndex("by_statusExpiresAt", (q) => q.lte("statusExpiresAt", now))
      .filter((q) =>
        q.or(
          q.eq(q.field("status"), "completed"),
          q.eq(q.field("status"), "failed"),
          q.eq(q.field("status"), "expired"),
        ),
      )
      .take(MAX_DRAIN_ENVELOPES);
    let deleted = 0;
    for (const row of retained) {
      await ctx.db.delete(row._id);
      deleted += 1;
    }
    const applications = await ctx.db
      .query("runtimeIngressApplications")
      .withIndex("by_expiresAt", (q) => q.lte("expiresAt", now))
      .take(MAX_DRAIN_ENVELOPES);
    for (const row of applications) await ctx.db.delete(row._id);
    return { expired, deleted };
  },
});
