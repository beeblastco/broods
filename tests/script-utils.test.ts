/**
 * Script utility tests.
 * Cover generated agent runtime config used by CI and manual scripts.
 */

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "bun:test";
import { createScriptAgentConfig } from "../scripts/utils.ts";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("integration account setup scripts", () => {
  it("use one shared account username and separate channel agent names", () => {
    const files = [
      "scripts/configure-telegram-account.ts",
      "scripts/configure-discord-account.ts",
      "scripts/configure-github-account.ts",
      "scripts/configure-slack-account.ts",
      "scripts/configure-pancake-account.ts",
      ".github/workflows/deploy.yaml",
    ].map((path) => readFileSync(path, "utf-8"));
    const combined = files.join("\n");

    expect(combined).toContain("INTEGRATIONS_ACCOUNT_USERNAME");
    expect(combined).toContain("TELEGRAM_AGENT_NAME");
    expect(combined).toContain("DISCORD_AGENT_NAME");
    expect(combined).toContain("GITHUB_AGENT_NAME");
    expect(combined).toContain("SLACK_AGENT_NAME");
    expect(combined).toContain("PANCAKE_AGENT_NAME");
    expect(combined).not.toContain("TELEGRAM_ACCOUNT_USERNAME");
    expect(combined).not.toContain("DISCORD_ACCOUNT_USERNAME");
    expect(combined).not.toContain("GITHUB_ACCOUNT_USERNAME");
    expect(combined).not.toContain("SLACK_ACCOUNT_USERNAME");
    expect(combined).not.toContain("PANCAKE_ACCOUNT_USERNAME");
  });
});

describe("script agent runtime config", () => {
  it("generates default Google model, provider, and tool config", () => {
    process.env = {};
    process.env.ACCOUNT_GOOGLE_API_KEY = "google-key";
    process.env.ACCOUNT_TAVILY_API_KEY = "tavily-key";

    expect(createScriptAgentConfig()).toEqual({
      model: {
        provider: "google",
        modelId: "gemma-4-31b-it",
      },
      agent: {
        system: expect.stringContaining("Knowledge cutoff: January 2025."),
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

    expect(createScriptAgentConfig()).toEqual({
      model: {
        provider: "openai",
        modelId: "gpt-custom",
      },
      agent: {
        system: expect.stringContaining("Knowledge cutoff: January 2025."),
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

  it("generates MiniMax provider config from environment variables", () => {
    process.env = {};
    process.env.ACCOUNT_MODEL_PROVIDER = "minimax";
    process.env.ACCOUNT_MODEL_ID = "MiniMax-M2.7";
    process.env.ACCOUNT_MINIMAX_API_KEY = "minimax-key";
    process.env.ACCOUNT_MINIMAX_BASE_URL = "https://api.minimax.io/anthropic/v1";

    expect(createScriptAgentConfig()).toEqual({
      model: {
        provider: "minimax",
        modelId: "MiniMax-M2.7",
      },
      agent: {
        system: expect.stringContaining("Knowledge cutoff: January 2025."),
      },
      provider: {
        minimax: {
          apiKey: "minimax-key",
          baseURL: "https://api.minimax.io/anthropic/v1",
        },
      },
      workspace: {
        enabled: true,
      },
      tools: {},
    });
  });

  it("allows integration setup to override the model knowledge cutoff", () => {
    process.env = {};
    process.env.ACCOUNT_GOOGLE_API_KEY = "google-key";
    process.env.ACCOUNT_MODEL_KNOWLEDGE_CUTOFF = "June 2026";

    expect(createScriptAgentConfig().agent?.system).toContain("Knowledge cutoff: June 2026.");
  });
});
