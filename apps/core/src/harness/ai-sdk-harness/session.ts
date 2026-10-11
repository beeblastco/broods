/**
 * Composition boundary between durable Broods sessions and live HarnessAgent sessions.
 */

import {
  HarnessCapabilityUnsupportedError,
  type HarnessAgent,
  type HarnessAgentResumeSessionState,
  type HarnessAgentSession,
} from "@ai-sdk/harness/agent";
import type { SandboxExecutorConfig } from "../sandbox/types.ts";
import { isSandboxGoneError } from "../sandbox/utils.ts";
import type {
  ConversationIngressEvent,
  Session,
  StoredHarnessSession,
} from "../session.ts";
import { extractText } from "../../shared/channels.ts";
import { logInfo, logWarn } from "../../shared/log.ts";
import {
  harnessSessionParking,
  harnessSharesSandbox,
  type AiSdkHarnessType,
} from "./adapters/index.ts";

const HARNESS_LEASE_RENEWAL_FAILURE_LIMIT = 3;
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
export function requireHarnessSandbox(
  sandbox: SandboxExecutorConfig | undefined,
): SandboxExecutorConfig {
  if (!sandbox) {
    throw new Error(
      "config.harness needs a sandbox to run on; list one first in config.sandboxes",
    );
  }

  return sandbox;
}

/**
 * Renews the conversation lease every second during a HarnessAgent turn and
 * aborts the run on a stop, a lost lease or repeated renewal failures.
 * Returns the function that stops the monitor.
 */
export function startHarnessLeaseMonitor(
  session: Session,
  abortController: AbortController,
  stopMessage: string,
): () => void {
  let checking = false;
  let consecutiveFailures = 0;
  const timer = setInterval(async () => {
    if (checking || abortController.signal.aborted) {
      return;
    }
    checking = true;
    try {
      const renewal = await session.renewConversationLease();
      consecutiveFailures = 0;
      if (renewal === "stopped") {
        abortController.abort(new Error(stopMessage));
      } else if (renewal === "stale") {
        abortController.abort(
          new Error("Conversation ownership changed during HarnessAgent turn"),
        );
      }
    } catch (error) {
      consecutiveFailures += 1;
      if (consecutiveFailures >= HARNESS_LEASE_RENEWAL_FAILURE_LIMIT) {
        abortController.abort(error);
      }
    } finally {
      checking = false;
    }
  }, 1_000);
  timer.unref();

  return () => clearInterval(timer);
}
