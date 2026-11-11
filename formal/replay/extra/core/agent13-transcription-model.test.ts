import { describe, expect, test } from "bun:test";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import { resolveTranscriptionModel } from "../../../../apps/core/src/harness/provider.ts";

function modelOf(config: AgentConfig): { provider: string; modelId: string } {
  const resolved = resolveTranscriptionModel(config);
  if ("reason" in resolved) throw new Error(resolved.reason);

  return {
    provider: resolved.model.provider,
    modelId: resolved.model.modelId,
  };
}

describe("resolveTranscriptionModel", (): void => {
  test.each<[AgentConfig["model"], string, string]>([
    [
      { provider: "openai", modelId: "gpt-5" },
      "openai.transcription",
      "whisper-1",
    ],
    [
      { provider: "groq", modelId: "llama" },
      "groq.transcription",
      "whisper-large-v3-turbo",
    ],
    [
      { provider: "mistral", modelId: "mistral-large" },
      "mistral.transcription",
      "voxtral-mini-latest",
    ],
  ])(
    "%j transcribes with its provider's default model",
    (model, provider, modelId): void => {
      const name = (model as { provider: string }).provider;
      const config = {
        model: model,
        provider: { [name]: { apiKey: "sk-test" } },
      } as AgentConfig;

      expect(modelOf(config)).toEqual({ provider: provider, modelId: modelId });
    },
  );

  test("a configured transcription model replaces the default", (): void => {
    const config = {
      model: { provider: "openai", modelId: "gpt-5" },
      transcription: { modelId: "gpt-4o-transcribe" },
      provider: { openai: { apiKey: "sk-test" } },
    } as AgentConfig;

    expect(modelOf(config).modelId).toBe("gpt-4o-transcribe");
  });
});
