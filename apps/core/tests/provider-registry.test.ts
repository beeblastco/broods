import { describe, expect, it } from "bun:test";
import { generateText } from "ai";
import {
  modelSettingsFromModelConfig,
  resolveConfiguredModel,
  resolveTranscriptionModel,
} from "../src/harness/provider.ts";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  type AccountModelProviderName,
} from "@broods/convex/model/modelProviders";
import { normalizeAgentConfig } from "@broods/convex/model/agentRules";

const PROVIDER_REQUIRED_SETTINGS: Partial<
  Record<AccountModelProviderName, Record<string, string>>
> = {
  cloudflare: { accountId: "account-test" },
  custom: { base_url: "https://llm.example.com/v1" },
};

// `chatgpt` runs on the account's `chatgpt` connection, not an API key or a factory.
const API_KEY_PROVIDER_NAMES = ACCOUNT_MODEL_PROVIDER_NAMES.filter(
  (name) => name !== "chatgpt",
);

describe("model provider registry", () => {
  it.each(API_KEY_PROVIDER_NAMES)(
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

  // The gateway route is pinned in harness.test.ts, whose factory mock leaks into later files.
  it("sends Cloudflare to Workers AI when no gateway is named", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request): Promise<Response> => {
        calls.push(input instanceof Request ? input.url : String(input));

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
        provider: { cloudflare: { apiKey: "cf-token", accountId: "acct" } },
      });
      await generateText({ model: model, prompt: "hi", maxRetries: 0 }).catch(
        () => undefined,
      );

      expect(calls[0]).toBe(
        "https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // The gateway's OpenAI-compatible route refuses the array-of-parts content every turn sends.
  it("sends a Workers AI model through the gateway's Workers AI route", async () => {
    const requests: Request[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        requests.push(
          new Request(
            input instanceof Request ? input.url : String(input),
            init,
          ),
        );

        return Response.json({ error: "stop" }, { status: 400 });
      },
      { preconnect: realFetch.preconnect },
    );
    try {
      const { model } = resolveConfiguredModel({
        model: {
          provider: "cloudflare",
          modelId: "workers-ai/@cf/meta/llama-3.1-8b-instruct-fast",
        },
        provider: {
          cloudflare: {
            apiKey: "cf-token",
            accountId: "acct",
            gatewayId: "gw",
          },
        },
      });
      await generateText({
        model: model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hi" },
              { type: "text", text: "<environment>" },
            ],
          },
        ],
        maxRetries: 0,
      }).catch(() => undefined);
      const [request] = requests;

      expect(request?.url).toBe(
        "https://gateway.ai.cloudflare.com/v1/acct/gw/workers-ai/run/@cf/meta/llama-3.1-8b-instruct-fast",
      );
      expect(request?.headers.get("cf-aig-authorization")).toBe(
        "Bearer cf-token",
      );
      expect(await request?.json()).toMatchObject({
        messages: [{ content: expect.any(String) }],
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

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

// Which providers transcribe is pinned by the type of `PROVIDER_TRANSCRIPTION`, not here.
describe("transcription model resolution", () => {
  it("names the provider that ships no speech-to-text", () => {
    expect(
      resolveTranscriptionModel({
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        provider: { anthropic: { apiKey: "sk-test" } },
      }),
    ).toEqual({ reason: "anthropic has no transcription model" });
  });

  it("names the missing credentials of the agent's own provider", () => {
    expect(
      resolveTranscriptionModel({
        model: { provider: "openai", modelId: "gpt-5" },
      }),
    ).toEqual({ reason: "config.provider.openai is required" });
  });

  it("transcribes on config.transcription.provider with its own key", () => {
    const resolved = resolveTranscriptionModel({
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      transcription: { provider: "openai" },
      provider: {
        anthropic: { apiKey: "sk-test" },
        openai: { apiKey: "sk-test" },
      },
    });

    expect("model" in resolved && resolved.model).toMatchObject({
      provider: "openai.transcription",
      modelId: "whisper-1",
    });
  });

  it("transcribes on a speech-to-text only provider", () => {
    const resolved = resolveTranscriptionModel({
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      transcription: { provider: "fishaudio" },
      provider: {
        anthropic: { apiKey: "sk-test" },
        fishaudio: { apiKey: "sk-test" },
      },
    });

    expect("model" in resolved && resolved.model).toMatchObject({
      provider: "fish-audio.transcription",
      modelId: "transcribe-1",
    });
  });

  it("names the missing credentials of the transcription provider", () => {
    expect(
      resolveTranscriptionModel({
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        transcription: { provider: "openai" },
        provider: { anthropic: { apiKey: "sk-test" } },
      }),
    ).toEqual({ reason: "config.provider.openai is required" });
  });
});

describe("modelSettingsFromModelConfig", () => {
  it("keeps the agent's own retry count and timeouts", () => {
    const timeout = { stepMs: 120_000, firstChunkMs: 30_000 };
    expect(
      modelSettingsFromModelConfig({
        model: {
          provider: "openai",
          modelId: "gpt-5",
          maxRetries: 1,
          timeout: timeout,
        },
      }),
    ).toEqual({ maxRetries: 1, timeout: timeout });
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
