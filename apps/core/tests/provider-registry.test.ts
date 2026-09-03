/**
 * The provider registry is the one place a model provider is declared. These
 * tests pin it to the shared name list and check that every entry really
 * resolves to a Vercel AI SDK factory, which `satisfies` alone cannot prove.
 */

import { describe, expect, it } from "bun:test";
import {
  modelProviderFactories,
  resolveConfiguredModel,
  resolveTranscriptionModels,
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

// That the three transcribing providers still expose `transcription` is pinned
// by the type of `PROVIDER_TRANSCRIPTION`, not by a test: a rename fails
// `bun run check`, which no module mock can hide. What is left to check is that
// a provider outside that map, or one that cannot be built, loses its
// transcript instead of throwing into the message it arrived on.
describe("transcription model resolution", () => {
  it("has none for a provider that ships no speech-to-text", () => {
    expect(
      resolveTranscriptionModels({
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        provider: { anthropic: { apiKey: "sk-test" } },
      }),
    ).toEqual([]);
  });

  it("has none when the provider is configured without credentials", () => {
    expect(
      resolveTranscriptionModels({
        model: { provider: "openai", modelId: "gpt-5" },
      }),
    ).toEqual([]);
  });
});
