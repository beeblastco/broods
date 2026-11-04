import { APICallError } from "@ai-sdk/provider";
import { transcribe, type TranscriptionModel } from "ai";
import type { AgentConfig } from "../shared/domain/agent-config.ts";
import { toErrorMessage } from "../shared/errors.ts";
import { logWarn } from "../shared/log.ts";
import { resolveTranscriptionModel } from "./provider.ts";

// Ingest must not hold the first reply for a backoff; the agent retries off the critical path.
export const TRANSCRIPTION_RETRIES = { ingest: 0, tool: 2 } as const;

// maxRetries bounds attempts, not a socket that never answers; sized for long recordings.
const TRANSCRIPTION_TIMEOUT_MS = 60_000;

export type TranscriptOutcome =
  | { status: "transcribed"; text: string }
  | { status: "failed"; reason: string; recovery: TranscriptRecovery };

export type TranscriptRecovery = "retry" | "unsupported" | "unavailable";

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
      // User speech stays out of Tempo, as in the agent spans.
      telemetry: {
        functionId: "harness.transcribe",
        recordInputs: false,
        recordOutputs: false,
      },
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

// A 400 is the provider refusing the file itself; any other error is about the account.
function recoveryFor(error: unknown): TranscriptRecovery {
  if (!APICallError.isInstance(error)) {
    return "unavailable";
  }
  if (error.isRetryable) {
    return "retry";
  }

  return error.statusCode === 400 ? "unsupported" : "unavailable";
}
