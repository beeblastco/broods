/**
 * Transport-neutral ingress admission and status helpers.
 * Convex owns atomic FIFO and fencing; handlers decide how accepted work is delivered.
 */

import type { ModelMessage, SystemModelMessage, UserModelMessage } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { runtime } from "../shared/convex/runtime.ts";
import {
  accountAgentScopedKey,
  parseAccountAgentScopedKey,
  publicConversationKeyFromScoped,
} from "../shared/runtime-keys.ts";

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

export interface PublicDeploymentIngress {
  accountId: string;
  endpointId: string;
  stageSlug: string;
  projectSlug: string;
}

export interface ConversationDispatchTarget {
  agentConfig: AgentConfig;
  channelName: string;
  source: Record<string, unknown>;
}

export interface SessionMessageInput {
  conversationKey: string;
  message: string;
}

export interface SessionMessageResult {
  conversationKey: string;
  status: "accepted" | "queued";
}

export interface PreparedSessionMessage {
  candidate: Omit<IngressCandidate, "agentConfig" | "delivery" | "events"> & {
    agentConfig: AgentConfig;
    delivery: Extract<IngressDelivery, { kind: "channel" }>;
    events: UserModelMessage[];
  };
  publicEventId: string;
  publicConversationKey: string;
}

export type RunSessionMessageDispatch = (
  input: SessionMessageInput,
) => Promise<SessionMessageResult>;

export type IngressDelivery =
  | {
      kind: "http";
      publicEventId: string;
      publicConversationKey: string;
      statusUrl?: string;
      publicDeploymentIngress?: PublicDeploymentIngress;
    }
  | {
      kind: "async";
      publicEventId: string;
      publicConversationKey: string;
      statusUrl: string;
      publicDeploymentIngress?: PublicDeploymentIngress;
    }
  | {
      kind: "websocket";
      publicEventId: string;
      publicConversationKey: string;
      connectionId: string;
      statusUrl?: string;
      publicDeploymentIngress?: PublicDeploymentIngress;
    }
  | { kind: "channel"; channel: string; source?: Record<string, unknown> };

export interface IngressCandidate {
  activeOwnerOnly?: boolean;
  expectedOwnerTaskId?: string;
  ownerTaskId?: string;
  accountId: string;
  agentId: string;
  eventId: string;
  conversationKey: string;
  events: ModelMessage[];
  requestedMode: IngressMode;
  idempotencyKey: string;
  delivery: IngressDelivery;
  // Per-request execution context persisted with the envelope so a queued
  // request runs under its own config/overrides, never a previous owner's.
  agentConfig?: AgentConfig;
  ephemeralSystem?: SystemModelMessage[];
}

export interface AppliedIngress {
  eventId: string;
  events: ModelMessage[];
  delivery: IngressDelivery;
  requestedMode: IngressMode;
  appliedMode: AppliedIngressMode;
  appliedToEventId: string;
  contributingEventIds: string[];
  ownerGeneration: number;
  agentConfig?: AgentConfig;
  ephemeralSystem?: SystemModelMessage[];
}

export type IngressAdmission = {
  outcome:
    | "owner"
    | "queued"
    | "duplicate"
    | "rejected"
    | "capacity"
    | "conflict"
    | "not_running";
  eventId?: string;
  status?: IngressStatus;
  ownerGeneration?: number;
  sequence?: number;
  // Set when admission recovered an expired owner by promoting the oldest
  // queued envelope; the caller must schedule this recovered application.
  recovered?: AppliedIngress;
};

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
  stoppedByUser?: boolean;
  result?: unknown;
  publicDeploymentIngress?: PublicDeploymentIngress;
}

export const DEFAULT_INGRESS_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_INGRESS_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_INGRESS_MAX_COUNT = 100;
export const DEFAULT_INGRESS_MAX_BYTES = 1024 * 1024;
export const DEFAULT_CONVERSATION_LEASE_TTL_MS = 15 * 60 * 1000;

/** Atomically admits one candidate into the durable conversation coordinator. */
export async function acceptIngress(
  candidate: IngressCandidate,
): Promise<IngressAdmission> {
  const serializedPayload = JSON.stringify({
    events: candidate.events,
    ...(candidate.agentConfig !== undefined
      ? { agentConfig: candidate.agentConfig }
      : {}),
    ...(candidate.ephemeralSystem !== undefined
      ? { ephemeralSystem: candidate.ephemeralSystem }
      : {}),
  });
  // The digest covers every execution-changing field so an idempotent retry
  // with different overrides is a conflict, not a silent duplicate.
  const payloadDigest = await sha256Hex(
    JSON.stringify({
      events: candidate.events,
      requestedMode: candidate.requestedMode,
      deliveryKind: candidate.delivery.kind,
      activeOwnerOnly: candidate.activeOwnerOnly,
      expectedOwnerTaskId: candidate.expectedOwnerTaskId,
      ownerTaskId: candidate.ownerTaskId,
      agentConfig: candidate.agentConfig,
      ephemeralSystem: candidate.ephemeralSystem,
    }),
  );

  return runtime.mutate<IngressAdmission>("acceptIngress", {
    ...candidate,
    ...(candidate.delivery.kind === "channel" && candidate.agentConfig
      ? {
          channelTarget: {
            agentConfig: candidate.agentConfig,
            channelName: candidate.delivery.channel,
            source: candidate.delivery.source ?? {},
          },
        }
      : {}),
    payloadDigest: payloadDigest,
    sizeBytes: new TextEncoder().encode(serializedPayload).byteLength,
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
    envelopeTtlMs: DEFAULT_INGRESS_TTL_MS,
    statusTtlMs: DEFAULT_INGRESS_STATUS_TTL_MS,
    maxQueuedCount: DEFAULT_INGRESS_MAX_COUNT,
    maxQueuedBytes: DEFAULT_INGRESS_MAX_BYTES,
  });
}

export async function prepareSessionMessage(options: {
  accountId: string;
  agentId: string;
  sourceConversationKey: string;
  input: SessionMessageInput;
}): Promise<PreparedSessionMessage> {
  const requestedKey = options.input.conversationKey.trim();
  if (!requestedKey || !options.input.message.trim()) {
    throw new Error("Target conversation and message must not be empty");
  }
  const requestedScope = parseAccountAgentScopedKey(requestedKey);
  if (requestedKey.startsWith("acct:") && !requestedScope) {
    throw new Error("Target conversation key is invalid");
  }
  if (
    requestedScope &&
    (requestedScope.accountId !== options.accountId ||
      requestedScope.agentId !== options.agentId)
  ) {
    throw new Error("Target conversation must belong to the current agent");
  }
  const conversationKey = requestedScope
    ? requestedKey
    : accountAgentScopedKey(options.accountId, options.agentId, requestedKey);
  if (conversationKey === options.sourceConversationKey) {
    throw new Error("send-message cannot target the current conversation");
  }
  const target = await getConversationDispatchTarget({
    accountId: options.accountId,
    agentId: options.agentId,
    conversationKey: conversationKey,
  });
  if (!target) {
    throw new Error("Target conversation is not an existing channel session");
  }
  const publicEventId = `session-message-${crypto.randomUUID()}`;
  const eventId = accountAgentScopedKey(
    options.accountId,
    options.agentId,
    publicEventId,
  );
  const publicConversationKey = publicConversationKeyFromScoped(
    conversationKey,
    options.accountId,
    options.agentId,
  );

  return {
    candidate: {
      accountId: options.accountId,
      agentId: options.agentId,
      agentConfig: target.agentConfig,
      eventId: eventId,
      conversationKey: conversationKey,
      events: [
        {
          role: "user",
          content: `[Inter-session message from ${publicConversationKeyFromScoped(
            options.sourceConversationKey,
            options.accountId,
            options.agentId,
          )}]\n${options.input.message}`,
        },
      ],
      requestedMode: "followup",
      idempotencyKey: eventId,
      delivery: {
        kind: "channel",
        channel: target.channelName,
        source: target.source,
      },
    },
    publicEventId: publicEventId,
    publicConversationKey: publicConversationKey,
  };
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

/** Reads the durable channel destination for an existing agent conversation. */
export function getConversationDispatchTarget(options: {
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Promise<ConversationDispatchTarget | null> {
  return runtime.query("getConversationTarget", options);
}

/** Reads one accepted ingress status after repeating account/agent authorization. */
export function getIngressStatus(options: {
  accountId: string;
  agentId: string;
  eventId: string;
}): Promise<IngressStatusRecord | null> {
  return runtime.query("getIngressStatus", options);
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

/** Produces one stable digest for duplicate-payload comparison. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte): string => byte.toString(16).padStart(2, "0"))
    .join("");
}
