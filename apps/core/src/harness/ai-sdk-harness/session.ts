/**
 * Composition boundary between durable Broods sessions and live HarnessAgent sessions.
 */

import type {
  HarnessAgent,
  HarnessAgentResumeSessionState,
  HarnessAgentSession,
} from "@ai-sdk/harness/agent";
import type { Session } from "../session.ts";
import {
  harnessSessionParking,
  type AiSdkHarnessType,
} from "./adapters/index.ts";

export interface OpenAiSdkHarnessSessionOptions {
  abortSignal: AbortSignal;
  agent: HarnessAgent;
  broodsSession: Session;
  type: AiSdkHarnessType;
}

export interface ParkAiSdkHarnessSessionOptions {
  broodsSession: Session;
  nativeSession: HarnessAgentSession;
  successful: boolean;
  type: AiSdkHarnessType;
}

export async function openAiSdkHarnessSession(
  options: OpenAiSdkHarnessSessionOptions,
): Promise<HarnessAgentSession> {
  const stored = await options.broodsSession.loadHarnessSession();
  if (stored && stored.harnessType !== options.type) {
    throw new Error(
      `Conversation is already bound to the ${stored.harnessType} harness; clear it before switching to ${options.type}`,
    );
  }

  return options.agent.createSession({
    sessionId: stored?.sessionId ?? crypto.randomUUID(),
    ...(stored
      ? {
          resumeFrom: stored.resumeState as HarnessAgentResumeSessionState,
        }
      : {}),
    abortSignal: options.abortSignal,
  });
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
    });
  } catch (error) {
    await options.nativeSession.destroy().catch(() => {});
    throw error;
  }
}
