/**
 * The provider registry is the one place a model provider is declared. These
 * tests pin it to the shared name list and check that every entry really
 * resolves to a Vercel AI SDK factory, which `satisfies` alone cannot prove.
 */

import { describe, expect, it } from "bun:test";
import {
  modelProviderFactories,
  resolveConfiguredModel,
  type ProviderSettingsFor,
} from "../src/harness/provider.ts";
import { ACCOUNT_MODEL_PROVIDER_NAMES } from "../src/shared/providers.ts";
import { normalizeAgentConfig } from "../src/shared/domain/agent-config.ts";

// Compile-time half of the contract: per-provider settings are the AI SDK's own
// types, so provider-specific fields broods never declared are known under the
// provider that owns them. `bun run check` is what enforces this.
const bedrockSettings: ProviderSettingsFor<"bedrock"> = {
  apiKey: "sk-test",
  region: "us-east-1",
};
const vertexSettings: ProviderSettingsFor<"vertex"> = {
  project: "p",
  location: "us-central1",
};

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
    expect(bedrockSettings.region).toBe("us-east-1");
    expect(vertexSettings.location).toBe("us-central1");
  });

  it("passes provider-owned settings through validation untouched", () => {
    const config = normalizeAgentConfig({
      model: { provider: "xai", modelId: "grok-4" },
      provider: { xai: { apiKey: "sk-test", fetch: undefined } },
    });

    expect(config.model?.provider).toBe("xai");
    expect(config.provider?.xai?.apiKey).toBe("sk-test");
  });
});
