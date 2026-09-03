/**
 * Inbound audio, read as words.
 *
 * Audio is transcribed once at ingest and the words travel as text, which every
 * model reads and no provider refuses on media type. The transcription model is
 * built from the account's own provider settings, so this costs no extra
 * configuration.
 */

import { APICallError } from "@ai-sdk/provider";
import { transcribe } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { toErrorMessage } from "../shared/errors.ts";
import { logWarn } from "../shared/log.ts";
import { resolveTranscriptionModel } from "./provider.ts";

const TRANSCRIPTION_MAX_RETRIES = 2;

/**
 * What came of reading one audio file. `retryable` is what the agent acts on:
 * a provider with no speech-to-text will not grow one, so telling it to try
 * again would only cost a turn before it asks the sender anyway.
 */
export type TranscriptOutcome =
  | { status: "transcribed"; text: string }
  | { status: "failed"; reason: string; retryable: boolean };

/**
 * Reads one audio file into text with the account's own provider credentials.
 * Reports its outcome rather than throwing: a transcription outage costs a
 * transcript, never the message it arrived on.
 */
export async function transcribeAudio(
  agentConfig: AgentConfig,
  audio: Uint8Array,
): Promise<TranscriptOutcome> {
  const model = resolveTranscriptionModel(agentConfig);
  if (!model) {
    return {
      status: "failed",
      reason: `${agentConfig.model?.provider ?? "this provider"} has no transcription model`,
      retryable: false,
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
    const reason = toErrorMessage(error);
    logWarn("Inbound audio could not be transcribed", {
      provider: agentConfig.model?.provider,
      error: reason,
    });

    return {
      status: "failed",
      reason: reason,
      retryable: APICallError.isInstance(error) && error.isRetryable,
    };
  }
}
