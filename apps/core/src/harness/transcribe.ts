/**
 * Inbound audio, read as words.
 *
 * Audio is transcribed once at ingest and the words travel as text, which every
 * model reads and no provider refuses on media type. The models come from the
 * account's own provider settings, so this costs no extra configuration.
 *
 * A failure is never the end of it. Which failure it was decides what the agent
 * is told to do next, because the three are not the same problem: a busy
 * provider is worth reading the file again for, a refused container is worth
 * handing to the agent with the file, and an account with no speech-to-text is
 * worth asking the sender about instead of burning a turn discovering that.
 */

import { APICallError } from "@ai-sdk/provider";
import { transcribe, type TranscriptionModel } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { toErrorMessage } from "../shared/errors.ts";
import { logWarn } from "../shared/log.ts";
import { resolveTranscriptionModels } from "./provider.ts";

/**
 * How patient each caller can afford to be.
 *
 * Ingest runs before the agent has said anything, so a provider having a bad
 * minute must not hold the first reply for the length of a backoff — it fails
 * fast and the note tells the agent to read the file, which is the same call
 * made later and off the critical path. By then the agent is waiting on a tool
 * result and a couple of retries are cheaper than another round trip.
 */
export const TRANSCRIPTION_RETRIES = { ingest: 0, tool: 2 } as const;

/** What came of reading one audio file. */
export type TranscriptOutcome =
  | { status: "transcribed"; text: string }
  | { status: "failed"; reason: string; recovery: TranscriptRecovery };

/**
 * Why it failed, in the only terms that change what happens next.
 * `retry` — the provider was busy or broken, and the same call may work later.
 * `unsupported` — every model refused the file itself, so only the agent, which
 * has it in the workspace, can get any further.
 * `unavailable` — this account has no working speech-to-text, and nothing the
 * agent does will change that.
 */
export type TranscriptRecovery = "retry" | "unsupported" | "unavailable";

/**
 * Reads one audio file into text, trying each of the provider's models in turn.
 * Reports its outcome rather than throwing: a transcription failure costs a
 * transcript, never the message it arrived on.
 */
export async function transcribeAudio(
  agentConfig: AgentConfig,
  audio: Uint8Array,
  maxRetries: number,
): Promise<TranscriptOutcome> {
  return await transcribeWithModels(
    resolveTranscriptionModels(agentConfig),
    audio,
    agentConfig.model?.provider ?? "this provider",
    maxRetries,
  );
}

/**
 * The same, over models already built. Exported so the fallback can be driven
 * with stub models: the provider factories are replaced wholesale by other test
 * files, and this behaviour is too load-bearing to test only where they survive.
 */
export async function transcribeWithModels(
  models: Exclude<TranscriptionModel, string>[],
  audio: Uint8Array,
  provider: string,
  maxRetries: number,
): Promise<TranscriptOutcome> {
  let outcome: TranscriptOutcome = {
    status: "failed",
    reason: `${provider} has no transcription model`,
    recovery: "unavailable",
  };
  // Only a refused file is worth the next model: another one on the same
  // service will not fix a 429, and will not fix a rejected key either.
  for (const model of models) {
    outcome = await attemptTranscription(model, audio, provider, maxRetries);
    if (
      outcome.status === "transcribed" ||
      outcome.recovery !== "unsupported"
    ) {
      break;
    }
  }

  return outcome;
}

async function attemptTranscription(
  model: Exclude<TranscriptionModel, string>,
  audio: Uint8Array,
  provider: string,
  maxRetries: number,
): Promise<TranscriptOutcome> {
  try {
    const result = await transcribe({
      model: model,
      audio: audio,
      maxRetries: maxRetries,
    });

    return { status: "transcribed", text: result.text.trim() };
  } catch (error) {
    const reason = toErrorMessage(error);
    logWarn("Inbound audio could not be transcribed", {
      provider: provider,
      model: model.modelId,
      error: reason,
    });

    return { status: "failed", reason: reason, recovery: recoveryFor(error) };
  }
}

// A 400 is the provider reading the file and refusing it, which is the one
// failure another model can answer. Anything else it names — a rejected key, a
// model that is not there — is about the account, not the recording.
function recoveryFor(error: unknown): TranscriptRecovery {
  if (!APICallError.isInstance(error)) {
    return "unavailable";
  }
  if (error.isRetryable) {
    return "retry";
  }

  return error.statusCode === 400 ? "unsupported" : "unavailable";
}
