/**
 * The prompt-cache defaults `providerOptionsFromModelConfig` injects for a
 * conversation run, and the calls that must not get them.
 */

import { describe, expect, test } from "bun:test";
import { providerOptionsFromModelConfig } from "../src/harness/provider.ts";
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
