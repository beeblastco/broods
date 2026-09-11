/**
 * Inbound audio, read as words.
 *
 * Audio is transcribed once at ingest and travels as text, which every model
 * reads and no provider refuses on media type. The model comes from the
 * account's own provider settings; `config.model.transcriptionModelId` picks a
 * different one.
 */

import { APICallError } from "@ai-sdk/provider";
import { transcribe, type TranscriptionModel } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { toErrorMessage } from "../shared/errors.ts";
import { logWarn } from "../shared/log.ts";
import { resolveTranscriptionModel } from "./provider.ts";

/**
 * How patient each caller can afford to be. Ingest runs before the agent has
 * said anything, so a provider having a bad minute must not hold the first reply
 * for the length of a backoff; it fails fast and the note tells the agent to read
 * the file, off the critical path, where retries are cheaper than a round trip.
 */
export const TRANSCRIPTION_RETRIES = { ingest: 0, tool: 2 } as const;

/**
 * Ceiling on one speech-to-text call. `maxRetries` bounds attempts, not a socket
 * that never answers. Set above what a long recording legitimately needs: the
 * point is to end a hang, not to cut work short.
 */
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

/** What came of reading one audio file. */
export type TranscriptOutcome =
  | { status: "transcribed"; text: string }
  | { status: "failed"; reason: string; recovery: TranscriptRecovery };

/**
 * Why it failed, in the only terms that change what happens next.
 * `retry`. The provider was busy or broken, and the same call may work later.
 * `unsupported`. The model refused the file itself, so only the agent, which
 * has it in the workspace, can get any further.
 * `unavailable`. This account has no working speech-to-text, and nothing the
 * agent does will change that.
 */
export type TranscriptRecovery = "retry" | "unsupported" | "unavailable";

/**
 * Reads one audio file into text. Reports its outcome rather than throwing: a
 * transcription failure costs a transcript, never the message it arrived on.
 */
export async function transcribeAudio(
  agentConfig: AgentConfig,
  audio: Uint8Array,
  maxRetries: number,
): Promise<TranscriptOutcome> {
  const model = resolveTranscriptionModel(agentConfig);
  if (!model) {
    return {
      status: "failed",
      reason: `${agentConfig.model?.provider ?? "this provider"} has no transcription model`,
      recovery: "unavailable",
    };
  }

  return await transcribeWithModel(model, audio, maxRetries);
}

/** The same, over a model already built. Exported to be driven with a stub. */
export async function transcribeWithModel(
  model: Exclude<TranscriptionModel, string>,
  audio: Uint8Array,
  maxRetries: number,
): Promise<TranscriptOutcome> {
  try {
    const result = await transcribe({
      model: model,
      audio: audio,
      maxRetries: maxRetries,
      abortSignal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS),
    });

    return { status: "transcribed", text: result.text.trim() };
  } catch (error) {
    const reason = toErrorMessage(error);
    logWarn("Inbound audio could not be transcribed", {
      provider: model.provider,
      model: model.modelId,
      error: reason,
    });

    return { status: "failed", reason: reason, recovery: recoveryFor(error) };
  }
}

/**
 * The one next step that can work, for a failure that has one. Keyed by recovery
 * so a new kind is a build error rather than the mildest wording by default.
 */
export function transcriptAdvice(
  recovery: TranscriptRecovery,
  path: string | undefined,
): string {
  const advice: Record<TranscriptRecovery, string> = {
    retry: "Read the file to try again before you answer.",
    unsupported: `The transcription model refused the file itself, so reading it again will not help. It is still yours to work with${path ? ` at ${path}` : ""}. Say which formats the reason names, or ask what was said.`,
    unavailable: "Reading it again will not help; ask what was said.",
  };

  return advice[recovery];
}

// A 400 is the provider reading the file and refusing it, which is the agent's
// to work with because it holds the file. Anything else it names, a rejected key
// or a model that is not there, is about the account, not the recording.
function recoveryFor(error: unknown): TranscriptRecovery {
  if (!APICallError.isInstance(error)) {
    return "unavailable";
  }
  if (error.isRetryable) {
    return "retry";
  }

  return error.statusCode === 400 ? "unsupported" : "unavailable";
}
