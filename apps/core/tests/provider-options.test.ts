/**
 * The prompt-cache defaults `providerOptionsFromModelConfig` injects for a
 * conversation run, and the calls that must not get them.
 */

import { describe, expect, test } from "bun:test";
import {
  cacheBreakpointFromProviderOptions,
  providerOptionsFromModelConfig,
} from "../src/harness/provider.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";

const CONVERSATION_KEY = "channel:acct:chat";

describe("providerOptionsFromModelConfig", () => {
  test("defaults anthropic cacheControl to ephemeral", () => {
    const config: AgentConfig = {
      model: { provider: "anthropic", modelId: "claude-sonnet-5" },
    };

    expect(providerOptionsFromModelConfig(config, CONVERSATION_KEY)).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  test("keeps an explicit anthropic cacheControl and sibling options", () => {
    const config: AgentConfig = {
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        providerOptions: {
          anthropic: {
            cacheControl: { type: "ephemeral", ttl: "1h" },
            sendReasoning: false,
          },
        },
      },
    };

    expect(providerOptionsFromModelConfig(config, CONVERSATION_KEY)).toEqual({
      anthropic: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
        sendReasoning: false,
      },
    });
  });

  test("a call without a conversation gets no defaults", () => {
    const config: AgentConfig = {
      model: { provider: "anthropic", modelId: "claude-sonnet-5" },
    };

    expect(providerOptionsFromModelConfig(config)).toBeUndefined();
  });

  test("openai gets a promptCacheKey, never the anthropic default", () => {
    const config: AgentConfig = {
      model: { provider: "openai", modelId: "gpt-5.6-luna" },
    };

    const options = providerOptionsFromModelConfig(config, CONVERSATION_KEY);
    expect(options?.anthropic).toBeUndefined();
    expect(options?.openai?.promptCacheKey).toMatch(/^[0-9a-f]{32}$/);
  });

  test("leaves other providers untouched", () => {
    const config: AgentConfig = {
      model: { provider: "google", modelId: "gemini-3-pro" },
    };

    expect(
      providerOptionsFromModelConfig(config, CONVERSATION_KEY),
    ).toBeUndefined();
  });
});

describe("cacheBreakpointFromProviderOptions", () => {
  const breakpointFor = (
    provider: "anthropic" | "chatgpt" | "openai",
    modelId: string,
  ): unknown => {
    const config: AgentConfig = {
      model: { provider: provider, modelId: modelId },
    };

    return cacheBreakpointFromProviderOptions(
      config,
      providerOptionsFromModelConfig(config, CONVERSATION_KEY),
    );
  };

  test("anthropic reuses the run's cacheControl", () => {
    expect(breakpointFor("anthropic", "claude-sonnet-5")).toEqual({
      anthropic: { cacheControl: { type: "ephemeral" } },
    });
  });

  test("openai marks an explicit breakpoint from GPT-5.6 on", () => {
    const explicit = {
      openai: { promptCacheBreakpoint: { mode: "explicit" } },
    };

    expect(breakpointFor("openai", "gpt-6-luna")).toEqual(explicit);
    expect(breakpointFor("openai", "gpt-5.6-luna")).toEqual(explicit);
    expect(breakpointFor("openai", "gpt-7")).toEqual(explicit);
    expect(breakpointFor("openai", "ft:gpt-6-luna:org::abc")).toEqual(explicit);
  });

  test("models before GPT-5.6 and ChatGPT plan usage get none", () => {
    expect(breakpointFor("openai", "gpt-5.5")).toBeUndefined();
    expect(breakpointFor("openai", "gpt-5-mini")).toBeUndefined();
    expect(breakpointFor("openai", "o4-mini")).toBeUndefined();
    expect(breakpointFor("chatgpt", "gpt-6-sol")).toBeUndefined();
  });

  test("openai wins over an anthropic cacheControl left in the config", () => {
    const config: AgentConfig = {
      model: {
        provider: "openai",
        modelId: "gpt-6-luna",
        providerOptions: {
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
    };

    expect(
      cacheBreakpointFromProviderOptions(
        config,
        providerOptionsFromModelConfig(config, CONVERSATION_KEY),
      ),
    ).toEqual({ openai: { promptCacheBreakpoint: { mode: "explicit" } } });
  });

  test("a call without a conversation gets none", () => {
    const config: AgentConfig = {
      model: { provider: "openai", modelId: "gpt-6-luna" },
    };

    expect(
      cacheBreakpointFromProviderOptions(
        config,
        providerOptionsFromModelConfig(config),
      ),
    ).toBeUndefined();
  });
});
