/**
 * Composition boundary between durable Broods sessions and live HarnessAgent sessions.
 */

import {
  HarnessCapabilityUnsupportedError,
  type HarnessAgent,
  type HarnessAgentResumeSessionState,
  type HarnessAgentSession,
} from "@ai-sdk/harness/agent";
import type { ToolSet } from "ai";
import {
  formatSandboxStatus,
  occupySandbox,
  sandboxNeighbours,
  type SandboxUsage,
} from "../sandbox/live-status.ts";
import {
  configuredSandboxSpecs,
  isSandboxGoneError,
} from "../sandbox/utils.ts";
import type {
  ConversationIngressEvent,
  Session,
  StoredHarnessSession,
  TurnContextSnapshot,
} from "../session.ts";
import { extractText } from "../../shared/channels.ts";
import type { AgentConfig } from "../../shared/domain/agent-config.ts";
import { logInfo, logWarn } from "../../shared/log.ts";
import type { SandboxRunMetadata } from "../../shared/sandbox-sizes.ts";
import type { ResolvedAgentSandbox } from "../../shared/workspaces.ts";
import {
  harnessSessionParking,
  harnessSharesSandbox,
  type AiSdkHarnessType,
} from "./adapters/index.ts";
import type {
  AiSdkHarnessRuntime,
  createConfiguredHarnessAgent,
} from "./runtime.ts";

const HARNESS_LEASE_RENEWAL_FAILURE_LIMIT = 3;
// A machine only one conversation uses is released after a day idle instead of
// the default week, so abandoned subagent tasks stop holding machines.
const ISOLATED_SANDBOX_RELEASE_SECONDS = 24 * 60 * 60;
// Harness types whose runtime refused a mid-turn message in this process.
export const MID_TURN_STEERING_UNSUPPORTED = new Set<AiSdkHarnessType>();

export interface HarnessReservationOptions {
  /** The agent-level key its first sandbox reserves on, when it reserves one. */
  agentReservationKey: string | undefined;
  conversationKey: string;
  /** The task asked for a machine of its own. */
  isolated: boolean;
  stored: StoredHarnessSession | null;
  type: AiSdkHarnessType;
}

export interface OpenAiSdkHarnessSessionOptions {
  abortSignal: AbortSignal;
  agent: HarnessAgent;
  stored: StoredHarnessSession | null;
  type: AiSdkHarnessType;
}

/** A native harness turn ready to stream, from `prepareHarnessTurn`. */
export interface HarnessTurn {
  /** Stops the lease monitor and destroys the native session; for a turn that fails before its stream. */
  dispose: () => Promise<void>;
  /** The environment text the model reads with the turn. */
  environment: string;
  nativeSession: HarnessAgentSession;
  /** Stored with the checkpoint so the next turn resumes on the same machine. */
  reservationKey: string;
  runtime: AiSdkHarnessRuntime;
  stopLeaseMonitor: () => void;
}

export interface PrepareHarnessTurnOptions {
  abortController: AbortController;
  agentConfig: AgentConfig;
  /** The agent-level key its first sandbox reserves on, when it reserves one. */
  agentReservationKey: string | undefined;
  /** Drains steering queued before the turn into `turnContext`. */
  applySteering: () => Promise<void>;
  /** Tool names the agent config sends to a person for approval. */
  configuredApprovals: ReadonlyMap<string, true>;
  /** The run loop passes the entrypoint's agent factory and session opener. */
  createAgent: typeof createConfiguredHarnessAgent;
  /** The task asked for a machine of its own. */
  isolated: boolean;
  metadata: SandboxRunMetadata;
  /** Takes the machine occupancy release; the caller runs it when the run finalizes, also when setup throws. */
  onOccupied: (release: () => void) => void;
  openSession: typeof openAiSdkHarnessSession;
  /** The agent's first sandbox, which the harness runs on. */
  sandbox: ResolvedAgentSandbox | undefined;
  session: Session;
  stopMessage: string;
  tools: ToolSet;
  turnContext: TurnContextSnapshot;
}

export interface ParkAiSdkHarnessSessionOptions {
  broodsSession: Session;
  nativeSession: HarnessAgentSession;
  /** Stored with the checkpoint so the next turn resumes on the same machine. */
  reservationKey: string;
  successful: boolean;
  type: AiSdkHarnessType;
}

/**
 * The reservation a harness conversation runs on; the run loop in `harness.ts` calls it.
 * A stored session keeps its own (older rows fall back to the conversation key). A new
 * one shares the agent's machine unless the task is isolated or the adapter can't share.
 */
export function harnessReservationKey(
  options: HarnessReservationOptions,
): string {
  if (options.stored) {
    return options.stored.reservationKey ?? options.conversationKey;
  }
  if (options.isolated || !harnessSharesSandbox(options.type)) {
    return options.conversationKey;
  }

  return options.agentReservationKey ?? options.conversationKey;
}

/**
 * Starts the native session for a harness turn, resuming the stored one when it
 * exists. Called by the run loop in `harness.ts`; a released machine starts fresh.
 */
export async function openAiSdkHarnessSession(
  options: OpenAiSdkHarnessSessionOptions,
): Promise<HarnessAgentSession> {
  const stored = options.stored;
  if (stored && stored.harnessType !== options.type) {
    throw new Error(
      `Conversation is already bound to the ${stored.harnessType} harness; clear it before switching to ${options.type}`,
    );
  }

  if (!stored) {
    return options.agent.createSession({
      sessionId: crypto.randomUUID(),
      abortSignal: options.abortSignal,
    });
  }
  try {
    return await options.agent.createSession({
      sessionId: stored.sessionId,
      resumeFrom: stored.resumeState as HarnessAgentResumeSessionState,
      abortSignal: options.abortSignal,
    });
  } catch (error) {
    // The machine idled past its reservation window and was released. The
    // conversation continues on a fresh machine and native session; only the
    // harness-side context of earlier turns is lost.
    if (!isSandboxGoneError(error)) throw error;
    logWarn("Harness machine was released; starting a fresh session", {
      sessionId: stored.sessionId,
      reservationKey: stored.reservationKey,
    });

    return options.agent.createSession({
      sessionId: crypto.randomUUID(),
      abortSignal: options.abortSignal,
    });
  }
}

/**
 * Detaches or stops the native session after a turn and saves its resume state on
 * the Broods session. Called by the run loop in `harness.ts`; destroys it on failure.
 */
export async function parkAiSdkHarnessSession(
  options: ParkAiSdkHarnessSessionOptions,
): Promise<void> {
  try {
    const resumeState =
      options.successful && harnessSessionParking(options.type) === "detach"
        ? await options.nativeSession.detach()
        : await options.nativeSession.stop();
    // The save itself is owner-fenced: a stale run's write is refused there.
    await options.broodsSession.saveHarnessSession({
      harnessType: options.type,
      sessionId: options.nativeSession.sessionId,
      resumeState: resumeState,
      reservationKey: options.reservationKey,
    });
  } catch (error) {
    await options.nativeSession.destroy().catch(() => {});
    throw error;
  }
}

/**
 * Sets up a native harness turn: stores the pending input, applies steering,
 * loads the stored session, builds the agent on its machine and opens the
 * session, renewing the conversation lease from before the open. Called by the
 * run loop in `harness.ts`, which owns finalization and the occupancy release.
 */
export async function prepareHarnessTurn(
  options: PrepareHarnessTurnOptions,
): Promise<HarnessTurn> {
  const { agentConfig, session, turnContext } = options;
  if (!agentConfig.harness) {
    throw new Error("a native harness turn needs config.harness");
  }
  const harnessType = agentConfig.harness.type;
  // No step boundary carries the turn's input on this path: store it now.
  await session.flushPendingStoredEvents();
  await options.applySteering();
  const stored = await session.loadHarnessSession();
  const reservationKey = harnessReservationKey({
    agentReservationKey: options.agentReservationKey,
    conversationKey: session.conversationKey,
    isolated: options.isolated,
    stored: stored,
    type: harnessType,
  });
  const shared = reservationKey !== session.conversationKey;
  const sandbox = requireHarnessSandbox(options.sandbox);
  const compute = sandbox.sandbox;
  let usage: SandboxUsage | undefined;
  const runtime = options.createAgent({
    agentConfig: agentConfig,
    compute:
      shared || !compute.controlPlane
        ? compute
        : {
            ...compute,
            controlPlane: {
              ...compute.controlPlane,
              releaseAfterIdleSeconds: ISOLATED_SANDBOX_RELEASE_SECONDS,
            },
          },
    id: session.agentId,
    instructions: turnContext.system
      .map((message) => message.content)
      .join("\n\n"),
    metadata: options.metadata,
    onUsage: (reported): void => {
      usage = reported;
    },
    reservationKey: reservationKey,
    shared: shared,
    skills: await session.loadHarnessSkills(),
    toolApproval:
      options.configuredApprovals.size > 0
        ? Object.fromEntries(
            [...options.configuredApprovals.keys()].map((name) => [
              name,
              "user-approval" as const,
            ]),
          )
        : undefined,
    tools: options.tools,
  });
  options.onOccupied(
    occupySandbox(runtime.reservationKey, session.eventId, {
      agentId: session.agentId,
      conversationKey: session.conversationKey,
    }),
  );
  // Opening a machine can outlast the lease, so renewal starts before it. A
  // lease lost during the open waits until the open settles: cancelling it
  // would leave a booting machine with no session to park or destroy.
  let opened = false;
  let lostDuringOpen: { reason: unknown } | undefined;
  const stopLeaseMonitor = startHarnessLeaseMonitor(
    session,
    options.abortController.signal,
    options.stopMessage,
    (reason: unknown): void => {
      if (opened) {
        options.abortController.abort(reason);
      } else {
        lostDuringOpen = { reason: reason };
      }
    },
  );
  const nativeSession = await options
    .openSession({
      abortSignal: options.abortController.signal,
      agent: runtime.agent,
      stored: stored,
      type: harnessType,
    })
    .catch((error: unknown): never => {
      stopLeaseMonitor();
      throw error;
    });
  opened = true;
  if (lostDuringOpen) {
    options.abortController.abort(lostDuringOpen.reason);
  }
  const dispose = async (): Promise<void> => {
    stopLeaseMonitor();
    await nativeSession.destroy().catch(() => {});
  };
  let environment: string;
  try {
    environment = session.environmentText(
      formatSandboxStatus({
        name: sandbox.name,
        provider: compute.provider,
        specs: configuredSandboxSpecs(compute),
        state: "running",
        shared: shared,
        usage: usage,
        neighbours: sandboxNeighbours(runtime.reservationKey, session.eventId),
      }),
    );
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    dispose: dispose,
    environment: environment,
    nativeSession: nativeSession,
    reservationKey: reservationKey,
    runtime: runtime,
    stopLeaseMonitor: stopLeaseMonitor,
  };
}

/**
 * Saves steering that arrived during a HarnessAgent turn, then hands it to the
 * running turn, which takes it at its next safe input boundary. Only for
 * adapters that accept mid-turn messages; the rest get it before their next
 * turn. A hand-over that fails throws and fails the run; the steer is already
 * in history, so a retry still reads it.
 */
export async function steerHarnessTurn(
  session: Session,
  harnessSession: HarnessAgentSession,
  type: AiSdkHarnessType,
): Promise<void> {
  // Only plain-text steers can be handed over; the rest stay queued for the
  // next turn, which takes them whole.
  const steering = await session.applySteeringIngress({ textOnly: true });
  if (!steering) {
    return;
  }
  const events = steering.events as ConversationIngressEvent[];
  const text = events
    .flatMap((event): string[] =>
      event.role === "user" ? [extractText(event.content).trim()] : [],
    )
    .filter(Boolean)
    .join("\n\n");
  await session.appendIngressEvents(events);
  if (text) {
    await harnessSession
      .experimental_steerTurn(text)
      .catch((error: unknown): never => {
        // This runtime cannot take one at all, so later turns in this process
        // leave steers queued for the next turn instead.
        if (error instanceof HarnessCapabilityUnsupportedError) {
          MID_TURN_STEERING_UNSUPPORTED.add(type);
        }
        throw error;
      });
  }
  logInfo("Steering ingress applied during HarnessAgent turn", {
    eventId: session.eventId,
    conversationKey: session.conversationKey,
    steeringEventCount: steering.contributingEventIds.length,
  });
}

/** The agent's first sandbox, which a harness run needs to run on. */
function requireHarnessSandbox(
  sandbox: ResolvedAgentSandbox | undefined,
): ResolvedAgentSandbox {
  if (!sandbox) {
    throw new Error(
      "config.harness needs a sandbox to run on; list one first in config.sandboxes",
    );
  }

  return sandbox;
}

/**
 * Renews the conversation lease every second during a HarnessAgent turn and
 * reports a stop, a lost lease or repeated renewal failures once through
 * `onLost`. Returns the function that stops the monitor; a renewal still in
 * flight then reports nothing.
 */
function startHarnessLeaseMonitor(
  session: Session,
  signal: AbortSignal,
  stopMessage: string,
  onLost: (reason: unknown) => void,
): () => void {
  let checking = false;
  let consecutiveFailures = 0;
  let done = false;
  const stop = (): void => {
    done = true;
    clearInterval(timer);
  };
  const lose = (reason: unknown): void => {
    if (done) return;
    stop();
    onLost(reason);
  };
  const timer = setInterval(async () => {
    if (checking || done || signal.aborted) {
      return;
    }
    checking = true;
    try {
      const renewal = await session.renewConversationLease();
      consecutiveFailures = 0;
      if (renewal === "stopped") {
        lose(new Error(stopMessage));
      } else if (renewal === "stale") {
        lose(
          new Error("Conversation ownership changed during HarnessAgent turn"),
        );
      }
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= HARNESS_LEASE_RENEWAL_FAILURE_LIMIT) {
        lose(error);
      }
    } finally {
      checking = false;
    }
  }, 1_000);
  timer.unref();

  return stop;
}
