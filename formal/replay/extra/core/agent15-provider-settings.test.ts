import { describe, expect, test } from "bun:test";

import { requireHarnessProviderSettings } from "../../../../apps/core/src/harness/ai-sdk-harness/provider.ts";
import { toLifecycleValue } from "../../../../apps/core/src/harness/lifecycle.ts";
import { resolveConfiguredModel } from "../../../../apps/core/src/harness/provider.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";

type ProviderSettings = NonNullable<AgentConfig["provider"]>["custom"];

function customConfig(settings: ProviderSettings): AgentConfig {
  return {
    model: { provider: "custom", modelId: "local-model" },
    provider: { custom: settings },
  };
}

describe("resolveConfiguredModel provider settings", (): void => {
  test("refuses a custom provider with no base url", (): void => {
    expect((): unknown =>
      resolveConfiguredModel(customConfig({ apiKey: "key-one" }), "acct_one"),
    ).toThrow("config.provider.custom.base_url is required");
  });

  test("refuses a blank base url", (): void => {
    expect((): unknown =>
      resolveConfiguredModel(
        customConfig({ apiKey: "key-one", baseURL: "   " }),
        "acct_one",
      ),
    ).toThrow("config.provider.custom.base_url is required");
  });

  test("points at the right spelling when baseUrl was used", (): void => {
    const settings = { apiKey: "key-one", baseUrl: "https://llm.example" };

    expect((): unknown =>
      resolveConfiguredModel(
        customConfig(settings as ProviderSettings),
        "acct_one",
      ),
    ).toThrow(`(found "baseUrl", use "base_url" or "baseURL")`);
  });

  test("refuses a config with no model id", (): void => {
    expect((): unknown =>
      resolveConfiguredModel(
        {
          model: { provider: "custom" },
          provider: { custom: { apiKey: "key-one" } },
        },
        "acct_one",
      ),
    ).toThrow("config.model.modelId is required");
  });
});

describe("requireHarnessProviderSettings", (): void => {
  test("refuses a provider with no settings", (): void => {
    expect((): unknown =>
      requireHarnessProviderSettings({}, "anthropic"),
    ).toThrow("config.provider.anthropic is required for config.harness");
  });

  test("refuses settings with no api key", (): void => {
    expect((): unknown =>
      requireHarnessProviderSettings(
        { provider: { anthropic: {} } },
        "anthropic",
      ),
    ).toThrow(
      "config.provider.anthropic.apiKey is required for config.harness",
    );
  });
});

describe("toLifecycleValue", (): void => {
  test("names a symbol by its description", (): void => {
    expect(toLifecycleValue(Symbol("marker"))).toBe("marker");
  });
});
