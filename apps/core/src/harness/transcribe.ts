/**
 * Inbound audio, read as words.
 *
 * Most providers cannot hear. A voice note that arrives for one of them is a
 * file the model can only be told about, and being told about a voice note is
 * useless: the agent ends up asking the sender to type what they just said.
 * So audio is transcribed once, at ingest, and the words travel as text — which
 * every model on every provider reads, with no media type to refuse.
 *
 * The transcription model is built from the account's own provider settings, so
 * this costs no configuration: an account that can already reach OpenAI can
 * already transcribe. A provider that ships no speech-to-text says so, and says
 * it in a way the agent can act on — `unavailable` means do not try again,
 * `failed` with `retryable` means the attempt itself is worth repeating.
 *
 * Nothing here throws. A transcript is an improvement on a turn, never a
 * precondition for one.
 */

import { APICallError } from "@ai-sdk/provider";
import { transcribe } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { logWarn } from "../shared/log.ts";
import { resolveTranscriptionModel } from "./provider.ts";

// The SDK's own retry, spent on the transient half of the failures: a 429 from
// a provider mid-spike, a 503. Past this the outcome is reported rather than
// retried, so one unlucky voice note cannot hold the turn open.
const TRANSCRIPTION_MAX_RETRIES = 2;

/**
 * What came of trying to read one audio file.
 * `unavailable` and `failed` are kept apart on purpose: the first is a standing
 * fact about the account's provider, the second is one attempt going wrong.
 * Only the second is worth trying again.
 */
export type TranscriptOutcome =
  | { status: "transcribed"; text: string }
  | { status: "failed"; reason: string; retryable: boolean }
  | { status: "unavailable"; reason: string };

/**
 * Reads one audio file into text with the account's own provider credentials.
 * Returns the outcome rather than throwing: a transcription outage costs a
 * transcript, never the message it arrived on.
 */
export async function transcribeAudio(
  agentConfig: AgentConfig,
  audio: Uint8Array,
): Promise<TranscriptOutcome> {
  const model = transcriptionModelFor(agentConfig);
  if (!model) {
    return {
      status: "unavailable",
      reason: `${agentConfig.model?.provider ?? "this provider"} has no transcription model configured`,
    };
  }
  try {
    const result = await transcribe({
      model: model,
      audio: audio,
      maxRetries: TRANSCRIPTION_MAX_RETRIES,
    });

    return { status: "transcribed", text: result.text.trim() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logWarn("Inbound audio could not be transcribed", {
      provider: agentConfig.model?.provider,
      error: reason,
    });

    return {
      status: "failed",
      reason: reason,
      retryable: APICallError.isInstance(error)
        ? error.isRetryable === true
        : false,
    };
  }
}

// Provider construction reads required config and throws when it is missing.
// That is the right answer for an agent turn and the wrong one here, where a
// half-configured account should lose its transcript and keep its message.
function transcriptionModelFor(
  agentConfig: AgentConfig,
): ReturnType<typeof resolveTranscriptionModel> {
  try {
    return resolveTranscriptionModel(agentConfig);
  } catch {
    return undefined;
  }
}
