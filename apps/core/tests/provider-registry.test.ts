/**
 * The provider registry is the one place a model provider is declared. These
 * tests pin it to the shared name list and check that every entry really
 * resolves to a Vercel AI SDK factory, which `satisfies` alone cannot prove.
 */

import { describe, expect, it } from "bun:test";
import { generateText } from "ai";
import {
  modelProviderFactories,
  modelSettingsFromModelConfig,
  resolveConfiguredModel,
  resolveTranscriptionModel,
} from "../src/harness/provider.ts";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  type AccountModelProviderName,
} from "@broods/convex/model/modelProviders";
import { normalizeAgentConfig } from "@broods/convex/model/agentRules";

// What a provider refuses to be built without, besides the API key.
const PROVIDER_REQUIRED_SETTINGS: Partial<
  Record<AccountModelProviderName, Record<string, string>>
> = {
  cloudflare: { accountId: "account-test" },
  custom: { base_url: "https://llm.example.com/v1" },
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

  it.each(ACCOUNT_MODEL_PROVIDER_NAMES)(
    "builds a %s model from an API key and its own required settings",
    (name) => {
      const resolved = resolveConfiguredModel({
        model: { provider: name, modelId: "some-model" },
        provider: {
          [name]: {
            apiKey: "sk-test",
            ...PROVIDER_REQUIRED_SETTINGS[name],
          },
        },
      });

      expect(resolved.providerName).toBe(name);
      expect(resolved.model).toBeDefined();
    },
  );

  it.each([{}, { baseURL: "" }])(
    "sends Ollama to Ollama Cloud, never core's own loopback, by default (%o)",
    async (endpoint) => {
      const urls: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (input: string | URL | Request): Promise<Response> => {
          urls.push(input instanceof Request ? input.url : String(input));

          return Response.json({ error: "stop" }, { status: 400 });
        },
        { preconnect: realFetch.preconnect },
      );
      try {
        const { model } = resolveConfiguredModel({
          model: { provider: "ollama", modelId: "gpt-oss:120b" },
          provider: { ollama: { apiKey: "sk-test", ...endpoint } },
        });
        await generateText({ model: model, prompt: "hi", maxRetries: 0 }).catch(
          () => undefined,
        );

        expect(new URL(urls[0] ?? "").hostname).toBe("ollama.com");
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );

  it.each([
    {
      gatewayId: undefined,
      url: "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      gatewayAuth: null,
    },
    {
      gatewayId: "gw",
      url: "https://gateway.ai.cloudflare.com/v1/acct/gw/compat/chat/completions",
      gatewayAuth: "Bearer cf-token",
    },
  ])(
    "sends Cloudflare to Workers AI, or to AI Gateway once gatewayId is set (%o)",
    async ({ gatewayId, url, gatewayAuth }) => {
      const calls: { url: string; headers: Headers }[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        async (
          input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          calls.push({
            url: input instanceof Request ? input.url : String(input),
            headers: new Headers(init?.headers),
          });

          return Response.json({ error: "stop" }, { status: 400 });
        },
        { preconnect: realFetch.preconnect },
      );
      try {
        const { model } = resolveConfiguredModel({
          model: {
            provider: "cloudflare",
            modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          },
          provider: {
            cloudflare: {
              apiKey: "cf-token",
              accountId: "acct",
              gatewayId: gatewayId,
            },
          },
        });
        await generateText({ model: model, prompt: "hi", maxRetries: 0 }).catch(
          () => undefined,
        );

        expect(calls[0]?.url).toBe(url);
        expect(calls[0]?.headers.get("cf-aig-authorization")).toBe(gatewayAuth);
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  );

  it("guards an endpoint under a name broods does not know", async () => {
    const { model } = resolveConfiguredModel({
      model: { provider: "openrouter", modelId: "openai/gpt-5" },
      provider: {
        openrouter: { apiKey: "sk-test", baseUrl: "https://10.0.0.8/api/v1" },
      },
    });

    const error = await generateText({
      model: model,
      prompt: "hi",
      maxRetries: 0,
    }).catch((caught: unknown) => caught);

    expect(String(error)).toMatch(/private address/);
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
    ).toEqual({ maxRetries: 5, temperature: 0.2 });
  });

  it("keeps the agent's own retry count", () => {
    expect(
      modelSettingsFromModelConfig({
        model: { provider: "openai", modelId: "gpt-5", maxRetries: 1 },
      }),
    ).toEqual({ maxRetries: 1 });
  });
});

describe("rate-limited model calls", () => {
  it.each([
    [
      "OpenAI",
      {
        error: {
          message:
            "Rate limit reached on tokens per min (TPM). Please try again in 300ms.",
          type: "tokens",
          code: "rate_limit_exceeded",
        },
      },
    ],
    [
      "Gemini",
      {
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              "@type": "type.googleapis.com/google.rpc.RetryInfo",
              retryDelay: "0.3s",
            },
          ],
        },
      },
    ],
  ])("waits as long as a %s 429 body asks before retrying", async (_, body) => {
    const calls: number[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        calls.push(Date.now());
        if (calls.length === 1) {
          return Response.json(body, { status: 429 });
        }

        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          created: 0,
          model: "gpt-test",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const config = {
        model: { provider: "deepseek" as const, modelId: "deepseek-chat" },
        provider: { deepseek: { apiKey: "sk-test" } },
      };
      const { model } = resolveConfiguredModel(config);
      const result = await generateText({
        model: model,
        prompt: "hi",
        ...modelSettingsFromModelConfig(config),
      });

      expect(result.text).toBe("ok");
      expect(calls).toHaveLength(2);
      const [first, second] = calls;
      if (first === undefined || second === undefined) {
        throw new Error("expected two model calls");
      }
      expect(second - first).toBeGreaterThanOrEqual(290);
      expect(second - first).toBeLessThan(1_500);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
