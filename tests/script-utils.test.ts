/**
 * Script utility tests.
 * Cover generated account runtime config used by CI and manual scripts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createScriptAccountRuntimeConfig } from "../scripts/utils.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("script account runtime config", () => {
  it("generates default Google model, provider, and tool config", () => {
    process.env = {};
    process.env.ACCOUNT_GOOGLE_API_KEY = "google-key";
    process.env.ACCOUNT_TAVILY_API_KEY = "tavily-key";

    expect(createScriptAccountRuntimeConfig()).toEqual({
      model: {
        provider: "google",
        modelId: "gemma-4-31b-it",
      },
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      workspace: {
        enabled: true,
      },
      tools: {
        tavilySearch: { enabled: true, apiKey: "tavily-key" },
        tavilyExtract: { enabled: true, apiKey: "tavily-key" },
      },
    });
  });

  it("uses provider and tools JSON overrides", () => {
    process.env = {};
    process.env.ACCOUNT_MODEL_PROVIDER = "openai";
    process.env.ACCOUNT_MODEL_ID = "gpt-custom";
    process.env.ACCOUNT_PROVIDER_CONFIG_JSON = JSON.stringify({
      apiKey: "openai-key",
      baseURL: "https://example.test/v1",
    });
    process.env.ACCOUNT_TOOLS_JSON = JSON.stringify({
      tavilySearch: { enabled: true },
    });

    expect(createScriptAccountRuntimeConfig()).toEqual({
      model: {
        provider: "openai",
        modelId: "gpt-custom",
      },
      provider: {
        openai: {
          apiKey: "openai-key",
          baseURL: "https://example.test/v1",
        },
      },
      workspace: {
        enabled: true,
      },
      tools: {
        tavilySearch: { enabled: true },
      },
    });
  });
});
