/**
 * Transport-neutral ingress admission and status helpers.
 * Convex owns atomic FIFO and fencing; handlers decide how accepted work is delivered.
 */

import type { ModelMessage } from "ai";
import { runtime } from "../shared/convex/runtime.ts";

export type IngressMode = "reject" | "followup" | "collect" | "steer";
export type AppliedIngressMode = IngressMode;
export type IngressStatus =
  | "accepted"
  | "queued"
  | "applied"
  | "processing"
  | "completed"
  | "failed"
  | "expired";

export type IngressDelivery =
  | {
      kind: "http";
      publicEventId: string;
      publicConversationKey: string;
      statusUrl?: string;
    }
  | {
      kind: "async";
      publicEventId: string;
      publicConversationKey: string;
      statusUrl: string;
    }
  | {
      kind: "websocket";
      publicEventId: string;
      publicConversationKey: string;
      connectionId: string;
      statusUrl?: string;
    }
  | { kind: "channel"; channel: string; source?: Record<string, unknown> };

export interface IngressCandidate {
  accountId: string;
  agentId: string;
  eventId: string;
  conversationKey: string;
  events: ModelMessage[];
  requestedMode: IngressMode;
  idempotencyKey: string;
  delivery: IngressDelivery;
}

export type IngressAdmission = {
  outcome:
    | "owner"
    | "queued"
    | "duplicate"
    | "rejected"
    | "capacity"
    | "conflict";
  eventId?: string;
  status?: IngressStatus;
  ownerGeneration?: number;
  sequence?: number;
};

export interface AppliedIngress {
  eventId: string;
  events: ModelMessage[];
  delivery: IngressDelivery;
  requestedMode: IngressMode;
  appliedMode: AppliedIngressMode;
  appliedToEventId: string;
  contributingEventIds: string[];
  ownerGeneration: number;
}

export interface IngressStatusRecord {
  eventId: string;
  conversationKey: string;
  requestedMode: IngressMode;
  appliedMode?: AppliedIngressMode;
  appliedToEventId?: string;
  status: IngressStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  error?: string;
  result?: unknown;
}

export const DEFAULT_INGRESS_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_INGRESS_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_INGRESS_MAX_COUNT = 100;
export const DEFAULT_INGRESS_MAX_BYTES = 1024 * 1024;
export const DEFAULT_CONVERSATION_LEASE_TTL_MS = 15 * 60 * 1000;

/** Produces one stable digest for duplicate-payload comparison. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Atomically admits one candidate into the durable conversation coordinator. */
export async function acceptIngress(
  candidate: IngressCandidate,
): Promise<IngressAdmission> {
  const serializedEvents = JSON.stringify(candidate.events);
  const payloadDigest = await sha256Hex(
    JSON.stringify({
      events: candidate.events,
      requestedMode: candidate.requestedMode,
      deliveryKind: candidate.delivery.kind,
    }),
  );

  return runtime.mutate<IngressAdmission>("acceptIngress", {
    ...candidate,
    payloadDigest: payloadDigest,
    sizeBytes: new TextEncoder().encode(serializedEvents).byteLength,
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
    envelopeTtlMs: DEFAULT_INGRESS_TTL_MS,
    statusTtlMs: DEFAULT_INGRESS_STATUS_TTL_MS,
    maxQueuedCount: DEFAULT_INGRESS_MAX_COUNT,
    maxQueuedBytes: DEFAULT_INGRESS_MAX_BYTES,
  });
}

/** Reads one accepted ingress status after repeating account/agent authorization. */
export function getIngressStatus(options: {
  accountId: string;
  agentId: string;
  eventId: string;
}): Promise<IngressStatusRecord | null> {
  return runtime.query("getIngressStatus", options);
}

/** Applies waiting steer envelopes at the current AI SDK step boundary. */
export function applySteering(options: {
  conversationKey: string;
  ownerEventId: string;
  ownerGeneration: number;
}): Promise<AppliedIngress | null> {
  return runtime.mutate("applyIngressSteering", {
    ...options,
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
  });
}

/** Takes the next FIFO follow-up or contiguous collect application. */
export function takeNextIngress(options: {
  conversationKey: string;
  ownerEventId: string;
  ownerGeneration: number;
}): Promise<AppliedIngress | null> {
  return runtime.mutate("takeNextIngress", {
    ...options,
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
  });
}

/** Settles every envelope applied to one active event under the fencing token. */
export function settleIngress(options: {
  conversationKey: string;
  ownerEventId: string;
  ownerGeneration: number;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
}): Promise<number> {
  return runtime.mutate("settleIngress", options);
}
