/**
 * Composition boundary between durable Broods sessions and live HarnessAgent sessions.
 */

import type {
  HarnessAgent,
  HarnessAgentResumeSessionState,
  HarnessAgentSession,
} from "@ai-sdk/harness/agent";
import { isSandboxGoneError } from "../sandbox/utils.ts";
import type { Session, StoredHarnessSession } from "../session.ts";
import { logWarn } from "../../shared/log.ts";
import {
  harnessSessionParking,
  harnessSharesSandbox,
  type AiSdkHarnessType,
} from "./adapters/index.ts";

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
 * The reservation a harness conversation runs on. A stored session keeps the one
 * it started on (rows from before this was stored ran on the conversation key). A
 * new one shares the agent's machine, each session in its own work folder, unless
 * the task asked to be isolated or the adapter's bridge needs the machine to itself.
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

export async function parkAiSdkHarnessSession(
  options: ParkAiSdkHarnessSessionOptions,
): Promise<void> {
  try {
    const resumeState =
      options.successful && harnessSessionParking(options.type) === "detach"
        ? await options.nativeSession.detach()
        : await options.nativeSession.stop();
    await options.broodsSession.assertCurrentOwner();
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
