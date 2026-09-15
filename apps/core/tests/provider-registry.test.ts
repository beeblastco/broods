/**
 * The provider registry is the one place a model provider is declared. These
 * tests pin it to the shared name list and check that every entry really
 * resolves to a Vercel AI SDK factory, which `satisfies` alone cannot prove.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { generateText } from "ai";
import {
  modelProviderFactories,
  modelSettingsFromModelConfig,
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

// That the three transcribing providers still expose `transcription` is pinned
// by the type of `PROVIDER_TRANSCRIPTION`, not by a test: a rename fails
// `bun run check`, which no module mock can hide. What is left to check is that
// a provider outside that map, or one that cannot be built, loses its
// transcript instead of throwing into the message it arrived on.
describe("transcription model resolution", () => {
  it("has none for a provider that ships no speech-to-text", () => {
    expect(
      resolveTranscriptionModel({
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        provider: { anthropic: { apiKey: "sk-test" } },
      }),
    ).toBeUndefined();
  });

  it("has none when the provider is configured without credentials", () => {
    expect(
      resolveTranscriptionModel({
        model: { provider: "openai", modelId: "gpt-5" },
      }),
    ).toBeUndefined();
  });
});

// The transcription id rides in config.model but is not a language-model
// setting, so it must not reach the call options the agent's own model is run
// with. An unknown key there is the provider's error, not ours.
describe("modelSettingsFromModelConfig", () => {
  it("leaves the transcription model out of the language model's settings", () => {
    expect(
      modelSettingsFromModelConfig({
        model: {
          provider: "openai",
          modelId: "gpt-5",
          transcriptionModelId: "gpt-4o-mini-transcribe",
          temperature: 0.2,
        },
      }),
    ).toEqual({ temperature: 0.2 });
  });
});

// Bun drops a fetch whose socket stays silent for 300s. A throttled provider held
// one step's stream that long and failed a 24-minute run, so model requests turn
// that timer off and end only on the provider's error or the run's abort.
describe("model request fetch", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends model requests with Bun's idle timeout off", async () => {
    const inits: BunFetchRequestInit[] = [];
    globalThis.fetch = (async (_input, init) => {
      inits.push(init ?? {});

      return new Response("{}", { status: 500 });
    }) as typeof fetch;
    const resolved = resolveConfiguredModel({
      model: { provider: "vertex", modelId: "gemini-2.5-flash" },
      provider: { vertex: { apiKey: "sk-test" } },
    });

    await expect(
      generateText({ model: resolved.model, prompt: "hi", maxRetries: 0 }),
    ).rejects.toThrow();

    expect(inits).toHaveLength(1);
    expect(inits[0]?.timeout).toBe(false);
  });
});
