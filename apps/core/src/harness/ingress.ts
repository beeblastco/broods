import type { ModelMessage, SystemModelMessage, UserModelMessage } from "ai";
import type { ChannelIdentity } from "../shared/channels.ts";
import { queuedCommand } from "../shared/commands.ts";
import {
  applyRunOverrides,
  toRuntimeAgentConfig,
  type AgentConfig,
  type RunOverrides,
} from "../shared/domain/agent-config.ts";
import {
  channelRuntimeAgentConfig,
  resolveChannelAgentId,
} from "../shared/domain/channel-record.ts";
import { runtime } from "../shared/convex/runtime.ts";
import {
  accountAgentScopedKey,
  createRunId,
  parseAccountAgentScopedKey,
  publicConversationKeyFromScoped,
  SLACK_INTEGRATION_PREFIX,
  TELEGRAM_INTEGRATION_PREFIX,
} from "../shared/runtime-keys.ts";
import { getStorage } from "../shared/storage.ts";
import type { AsyncAgentOutcome } from "./async-agent-result.ts";

export const CHANNEL_SESSION_KEY_FORMAT = `channel prefix plus platform ids, e.g. ${TELEGRAM_INTEGRATION_PREFIX}<chatId> (negative for groups), ${SLACK_INTEGRATION_PREFIX}<teamId>:<channelId>[:<threadTs>]`;
export const DEFAULT_INGRESS_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_INGRESS_STATUS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_INGRESS_MAX_COUNT = 100;
export const DEFAULT_INGRESS_MAX_BYTES = 1024 * 1024;
export const DEFAULT_CONVERSATION_LEASE_TTL_MS = 15 * 60 * 1000;
export const INGRESS_RETRY_HEADERS = { "Retry-After": "5" };

// Every lease this process takes or gives back goes through this file, so shutdown can
// hand back what runs past the drain deadline still hold.
const liveOwners = new Map<string, LiveOwner>();

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

export interface LiveOwner {
  conversationKey: string;
  ownerEventId: string;
  ownerGeneration: number;
}

export interface AsyncResultSettlement {
  eventIds: string[];
  outcome: AsyncAgentOutcome;
}

export type OwnedEventRows = NonNullable<
  Parameters<typeof runtime.mutate<"takeNextIngress">>[1]["events"]
>;

export interface IngressSettlement {
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
}

export interface RecoveredIngress {
  accountId: string;
  agentId: string;
  conversationKey: string;
  applied: AppliedIngress;
}

export interface PublicDeploymentIngress {
  accountId: string;
  endpointId: string;
  stageSlug: string;
  projectSlug: string;
}

export interface ChannelTargetRefs {
  // Absent when the running agent holds the channel credentials itself.
  credentialAgentId?: string;
  channelRecordId?: string;
}

export interface ConversationDispatchTarget extends IngressChannelRef {
  source: Record<string, unknown>;
}

export interface IngressChannelRef extends ChannelTargetRefs {
  channelName: string;
}

// Stored instead of the resolved config, which holds decrypted secrets. `{}`: the agent's own.
export interface IngressConfigRef {
  model?: RunOverrides["model"];
  channel?: IngressChannelRef;
}

export interface IngressRunConfig {
  agentConfig: AgentConfig;
  configRef: IngressConfigRef;
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
  candidate: Omit<IngressCandidate, "configRef" | "delivery" | "events"> & {
    configRef: IngressConfigRef;
    delivery: Extract<IngressDelivery, { kind: "channel" }>;
    events: UserModelMessage[];
  };
  agentConfig: AgentConfig;
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
  | {
      kind: "channel";
      channel: string;
      identity?: ChannelIdentity;
      source?: Record<string, unknown>;
    };

export interface IngressCandidate {
  activeOwnerOnly?: boolean;
  expectedOwnerTaskId?: string;
  ownerTaskId?: string;
  accountId: string;
  agentId: string;
  eventId: string;
  // Required: `delivery.statusUrl` already names it, so minting one here would orphan that URL.
  runId: string;
  conversationKey: string;
  events: ModelMessage[];
  requestedMode: IngressMode;
  idempotencyKey: string;
  delivery: IngressDelivery;
  // So a queued request runs on its own config; absent only on a subagent's envelopes.
  configRef?: IngressConfigRef;
  ephemeralSystem?: SystemModelMessage[];
  channelTarget?: ChannelTargetRefs;
  // Late subagent and async tool results: admitted only while the parent has not stored them.
  resultEventId?: string;
  toolResultId?: string;
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
  configRef?: IngressConfigRef;
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
  // On a duplicate, the first admission's, so a retried POST keeps one run id.
  runId?: string;
  status?: IngressStatus;
  ownerGeneration?: number;
  sequence?: number;
  // Promoted from an expired owner's queue: the caller must dispatch it.
  recovered?: AppliedIngress;
};

export interface IngressStatusRecord {
  eventId: string;
  runId?: string;
  agentId: string;
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

export async function acceptIngress(
  input: IngressCandidate,
): Promise<IngressAdmission> {
  // A command waits its own turn: steered, the model would read it as text; collected, batched.
  const candidate: IngressCandidate = queuedCommand(
    input.events,
    input.delivery.kind === "channel" ? input.delivery.channel : undefined,
  )
    ? { ...input, requestedMode: "followup" }
    : input;
  const serializedPayload = JSON.stringify({
    events: candidate.events,
    ...(candidate.configRef !== undefined
      ? { configRef: candidate.configRef }
      : {}),
    ...(candidate.ephemeralSystem !== undefined
      ? { ephemeralSystem: candidate.ephemeralSystem }
      : {}),
  });
  // Every execution-changing field, so a retry with other overrides conflicts, not dedupes.
  const payloadDigest = await sha256Hex(
    JSON.stringify({
      events: candidate.events,
      requestedMode: candidate.requestedMode,
      deliveryKind: candidate.delivery.kind,
      activeOwnerOnly: candidate.activeOwnerOnly,
      expectedOwnerTaskId: candidate.expectedOwnerTaskId,
      ownerTaskId: candidate.ownerTaskId,
      configRef: candidate.configRef,
      ephemeralSystem: candidate.ephemeralSystem,
    }),
  );

  const { channelTarget, ...admitted } = candidate;
  const admission = await runtime.mutate("acceptIngress", {
    ...admitted,
    ...(candidate.delivery.kind === "channel" && channelTarget
      ? {
          channelTarget: {
            ...channelTarget,
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
  if (admission.recovered) {
    trackOwner({
      conversationKey: candidate.conversationKey,
      ownerEventId: admission.recovered.eventId,
      ownerGeneration: admission.recovered.ownerGeneration,
    });
  }
  if (
    admission.outcome === "owner" &&
    admission.ownerGeneration !== undefined
  ) {
    trackOwner({
      conversationKey: candidate.conversationKey,
      ownerEventId: candidate.eventId,
      ownerGeneration: admission.ownerGeneration,
    });
  }

  return admission;
}

export function applySteering(options: {
  conversationKey: string;
  ownerEventId: string;
  ownerGeneration: number;
  textOnly?: boolean;
}): Promise<AppliedIngress | null> {
  return runtime.mutate("applyIngressSteering", {
    ...options,
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
  });
}

export function getConversationDispatchTarget(options: {
  accountId: string;
  agentId: string;
  conversationKey: string;
}): Promise<ConversationDispatchTarget | null> {
  return runtime.query("getConversationTarget", options);
}

export function getIngressStatus(options: {
  accountId: string;
  runId: string;
}): Promise<IngressStatusRecord | null> {
  return runtime.query("getIngressStatus", options);
}

export function getIngressStatusByEventId(options: {
  accountId: string;
  agentId: string;
  eventId: string;
}): Promise<IngressStatusRecord | null> {
  return runtime.query("getIngressStatusByEventId", options);
}

export async function interruptLiveOwners(error: string): Promise<number> {
  const owners = [...liveOwners.values()];
  const results = await Promise.allSettled(
    owners.map(async (owner): Promise<void> => {
      // Fenced: a no-op for a run that settled on its own meanwhile.
      await settleIngress({ ...owner, status: "failed", error: error }).catch(
        (): number => 0,
      );
      await releaseIngressOwner(owner);
    }),
  );

  return results.filter((result): boolean => result.status === "fulfilled")
    .length;
}

// Rebuilt from live rows every time, so a rotated key or a changed tool applies next run.
export async function loadChannelSessionConfig(options: {
  accountId: string;
  agentId: string;
  target: IngressChannelRef;
}): Promise<IngressRunConfig> {
  const { accountId, target } = options;
  const storage = getStorage();
  const [agent, credentialHolder, record] = await Promise.all([
    storage.agents.getById(accountId, options.agentId),
    target.credentialAgentId
      ? storage.agents.getById(accountId, target.credentialAgentId)
      : null,
    target.channelRecordId
      ? storage.channelRecords.getById(accountId, target.channelRecordId)
      : null,
  ]);
  if (!agent) {
    throw new Error(`Agent not found: ${options.agentId}`);
  }
  const activeRecord = record?.status === "active" ? record : undefined;
  const boundAgentId = activeRecord && resolveChannelAgentId(activeRecord);
  // A gone or rebound record: unreachable until the next channel turn repins it.
  if (
    (target.channelRecordId && !activeRecord) ||
    (boundAgentId && boundAgentId !== options.agentId) ||
    (target.credentialAgentId && !credentialHolder)
  ) {
    throw new Error("Channel session is no longer bound to this agent");
  }

  return {
    agentConfig: channelRuntimeAgentConfig(
      {
        agent: agent,
        ...(activeRecord ? { record: activeRecord } : {}),
      },
      target.channelName,
      (credentialHolder ?? agent).config,
    ),
    configRef: {
      channel: {
        channelName: target.channelName,
        ...(target.credentialAgentId
          ? { credentialAgentId: target.credentialAgentId }
          : {}),
        ...(target.channelRecordId
          ? { channelRecordId: target.channelRecordId }
          : {}),
      },
    },
  };
}

export async function loadAppliedIngressConfig(options: {
  accountId: string;
  agentId: string;
  configRef: IngressConfigRef | undefined;
  subagentConfig?: AgentConfig;
}): Promise<AgentConfig> {
  const { accountId, agentId, configRef } = options;
  if (!configRef) {
    if (options.subagentConfig) {
      return options.subagentConfig;
    }
    throw new Error("Queued turn was admitted before config refs; retry");
  }
  if (configRef.channel) {
    const loaded = await loadChannelSessionConfig({
      accountId: accountId,
      agentId: agentId,
      target: configRef.channel,
    });

    return loaded.agentConfig;
  }
  const agent = await getStorage().agents.getById(accountId, agentId);
  if (!agent) {
    throw new Error(`Agent not found: ${agentId}`);
  }

  return applyRunOverrides(
    toRuntimeAgentConfig(agent.config),
    configRef.model ? { model: configRef.model } : undefined,
  );
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
  const sourceKey = publicConversationKeyFromScoped(
    options.sourceConversationKey,
    options.accountId,
    options.agentId,
  );
  if (!target) {
    throw new Error(
      `Target conversation is not an existing channel session of this agent: it must be a chat that has messaged this agent before, keyed ${CHANNEL_SESSION_KEY_FORMAT}. This conversation's key is ${sourceKey}.`,
    );
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

  const { agentConfig, configRef } = await loadChannelSessionConfig({
    accountId: options.accountId,
    agentId: options.agentId,
    target: target,
  });

  return {
    candidate: {
      accountId: options.accountId,
      agentId: options.agentId,
      configRef: configRef,
      eventId: eventId,
      runId: createRunId(),
      conversationKey: conversationKey,
      events: [
        {
          role: "user",
          content: `[Inter-session message from ${sourceKey}]\n${options.input.message}`,
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
    agentConfig: agentConfig,
    publicEventId: publicEventId,
    publicConversationKey: publicConversationKey,
  };
}

// The caller now holds each returned lease and must dispatch every application.
export async function recoverQueuedIngress(
  afterConversationKey?: string,
): Promise<{ recovered: RecoveredIngress[]; continueAfter: string | null }> {
  const page = await runtime.mutate("recoverQueuedIngress", {
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
    ...(afterConversationKey === undefined
      ? {}
      : { afterConversationKey: afterConversationKey }),
  });
  for (const entry of page.recovered) {
    trackOwner({
      conversationKey: entry.conversationKey,
      ownerEventId: entry.applied.eventId,
      ownerGeneration: entry.applied.ownerGeneration,
    });
  }

  return page;
}

export async function releaseIngressOwner(owner: LiveOwner): Promise<void> {
  await runtime.mutate("releaseIngressOwner", {
    conversationKey: owner.conversationKey,
    ownerEventId: owner.ownerEventId,
    ownerGeneration: owner.ownerGeneration,
  });
  forgetOwner(owner);
}

export function renewIngressOwner(
  owner: LiveOwner,
): Promise<"renewed" | "stopped" | "stale"> {
  return runtime.mutate("renewIngressOwner", {
    conversationKey: owner.conversationKey,
    ownerEventId: owner.ownerEventId,
    ownerGeneration: owner.ownerGeneration,
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
  });
}

export function settleIngress(options: {
  conversationKey: string;
  ownerEventId: string;
  ownerGeneration: number;
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  asyncResult?: AsyncResultSettlement;
  events?: OwnedEventRows;
}): Promise<number> {
  return runtime.mutate("settleIngress", options);
}

export function outcomeSettlement(
  outcome: AsyncAgentOutcome,
): IngressSettlement {
  if (outcome.status === "completed") {
    return { status: "completed", result: outcome.response };
  }
  if (outcome.status === "failed") {
    return { status: "failed", error: outcome.error };
  }

  return { status: "completed", result: outcome };
}

export async function takeNextIngress(
  options: LiveOwner,
  settle?: IngressSettlement,
  events: OwnedEventRows = [],
): Promise<AppliedIngress | null> {
  const next = await runtime.mutate("takeNextIngress", {
    ...options,
    leaseTtlMs: DEFAULT_CONVERSATION_LEASE_TTL_MS,
    ...(settle ? { settle: settle } : {}),
    ...(events.length > 0 ? { events: events } : {}),
  });
  forgetOwner(options);
  if (next) {
    trackOwner({
      conversationKey: options.conversationKey,
      ownerEventId: next.eventId,
      ownerGeneration: next.ownerGeneration,
    });
  }

  return next;
}

function forgetOwner(owner: LiveOwner): void {
  const held = liveOwners.get(owner.conversationKey);
  if (
    held?.ownerEventId === owner.ownerEventId &&
    held.ownerGeneration === owner.ownerGeneration
  ) {
    liveOwners.delete(owner.conversationKey);
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte): string => byte.toString(16).padStart(2, "0"))
    .join("");
}

function trackOwner(owner: LiveOwner): void {
  liveOwners.set(owner.conversationKey, owner);
}
