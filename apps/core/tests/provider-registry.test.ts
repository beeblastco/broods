/**
 * The provider registry is the one place a model provider is declared. These
 * tests pin it to the shared name list and check that every entry really
 * resolves to a Vercel AI SDK factory, which `satisfies` alone cannot prove.
 */

import { describe, expect, it } from "bun:test";
import {
  modelProviderFactories,
  resolveConfiguredModel,
  resolveTranscriptionModel,
} from "../src/harness/provider.ts";
import { ACCOUNT_MODEL_PROVIDER_NAMES } from "@broods/convex/model/modelProviders";
import { normalizeAgentConfig } from "../src/shared/domain/agent-config.ts";

describe("model provider registry", () => {
  it("has a live AI SDK factory for every supported provider name", () => {
    const factories = modelProviderFactories();
    expect(Object.keys(factories).sort()).toEqual(
      [...ACCOUNT_MODEL_PROVIDER_NAMES].sort(),
    );
    for (const name of ACCOUNT_MODEL_PROVIDER_NAMES) {
      expect(typeof factories[name]).toBe("function");
    }
  });

  it("builds a model for a provider added purely through the registry", () => {
    const resolved = resolveConfiguredModel({
      model: { provider: "deepseek", modelId: "deepseek-reasoner" },
      provider: { deepseek: { apiKey: "sk-test" } },
    });

    expect(resolved.providerName).toBe("deepseek");
    expect(resolved.model).toBeDefined();
  });

  it("passes provider-owned settings through validation untouched", () => {
    const config = normalizeAgentConfig({
      model: { provider: "vertex", modelId: "gemini-2.5-flash" },
      // `project` and `location` are Vertex's own; broods declares neither.
      provider: {
        vertex: { apiKey: "sk-test", project: "p", location: "us-central1" },
      },
    });

    expect(config.model?.provider).toBe("vertex");
    expect(config.provider?.vertex).toEqual({
      apiKey: "sk-test",
      project: "p",
      location: "us-central1",
    });
  });
});

// `transcription` is read off the constructed provider, so a rename in the SDK
// would otherwise degrade quietly: the model comes back undefined, the note
// says the provider has none, and inbound audio stops being transcribed with
// nothing failing anywhere.
describe("transcription model resolution", () => {
  it.each([
    ["openai", "sk-test"],
    ["groq", "gsk-test"],
    ["mistral", "sk-test"],
  ] as const)("builds a transcription model for %s", (provider, apiKey) => {
    const model = resolveTranscriptionModel({
      model: { provider: provider, modelId: "test-model" },
      provider: { [provider]: { apiKey: apiKey } },
    });

    expect(model?.specificationVersion).toBe("v4");
  });

  it("has none for a provider that ships no speech-to-text", () => {
    expect(
      resolveTranscriptionModel({
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        provider: { anthropic: { apiKey: "sk-test" } },
      }),
    ).toBeUndefined();
  });
});
