/**
 * Agent harness tests.
 * Cover model-loop edge cases without calling provider APIs.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";

const ORIGINAL_ENV = { ...process.env };
const googleModelMock = mock((modelId: string) => ({ provider: "google", modelId }));
const createGoogleMock = mock((_options: unknown) => googleModelMock);
const openAIModelMock = mock((modelId: string) => ({ provider: "openai", modelId }));
const createOpenAIMock = mock((_options: unknown) => openAIModelMock);
const bedrockModelMock = mock((modelId: string) => ({ provider: "bedrock", modelId }));
const createBedrockMock = mock((_options: unknown) => bedrockModelMock);
const gatewayModelMock = mock((modelId: string) => ({ provider: "gateway", modelId }));
const createGatewayMock = mock((_options: unknown) => gatewayModelMock);

const streamTextMock = mock((options: {
  onFinish(args: { response: { messages: unknown[] }; text: string }): Promise<void>;
  stopWhen?: unknown;
}) => {
  let consumed = false;
  const fullStream = new ReadableStream({
    async start(controller) {
      await options.onFinish({
        response: { messages: [] },
        text: "   ",
      });
      controller.enqueue({ type: "finish", finishReason: "stop" });
      controller.close();
    },
  });

  return {
    fullStream,
    async consumeStream() {
      if (consumed) {
        return;
      }

      consumed = true;
      const reader = fullStream.getReader();
      while (!(await reader.read()).done) { }
    },
  };
});

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: createGoogleMock,
}));

mock.module("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAIMock,
}));

mock.module("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: createBedrockMock,
}));

mock.module("@ai-sdk/gateway", () => ({
  createGateway: createGatewayMock,
}));

mock.module("ai", () => ({
  ...actualAi,
  streamText: streamTextMock,
}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  streamTextMock.mockClear();
  googleModelMock.mockClear();
  createGoogleMock.mockClear();
  openAIModelMock.mockClear();
  createOpenAIMock.mockClear();
  bedrockModelMock.mockClear();
  createBedrockMock.mockClear();
  gatewayModelMock.mockClear();
  createGatewayMock.mockClear();
});

describe("runAgentLoop", () => {
  it("sends the error hook when the model finishes with empty text", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const persistModelMessages = mock(async () => { });
    const onErrorText = mock(async () => { });

    const stream = await runAgentLoop({
      conversationKey: "tg:7495331456",
      eventId: "tg-900151472",
      filesystemNamespace: () => "fs-test",
      persistModelMessages,
      loadRefreshedSystemPromptParts: async () => ({
        promptContext: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      hasPendingUserMessage: true,
      promptContext: { cursor: null, messages: [] },
    }, {
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-test",
      },
    }, {
      onFinalText: async () => {
        throw new Error("unexpected final text");
      },
      onErrorText,
    });

    await stream.consumeStream();

    expect(stream.didFail()).toBe(true);
    expect(stream.failureText()).toBe("Model returned empty response");
    expect(onErrorText).toHaveBeenCalledWith("Model returned empty response");
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("providerOptions");
  });

  it("passes account model config into streamText", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        promptContext: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      hasPendingUserMessage: true,
      promptContext: { cursor: null, messages: [] },
    }, {
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-custom",
        temperature: 0.2,
        maxOutputTokens: 2048,
        options: {
          google: {
            thinkingConfig: {
              thinkingLevel: "low",
            },
          },
        },
      },
    });

    await stream.consumeStream();

    expect(googleModelMock).toHaveBeenCalledWith("gemini-custom");
    expect(createGoogleMock).toHaveBeenCalledWith({ apiKey: "google-key" });
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "google", modelId: "gemini-custom" },
      temperature: 0.2,
      maxOutputTokens: 2048,
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingLevel: "low",
          },
        },
      },
    });
  });

  it("uses agent maxTurn for the model loop limit", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      persistModelMessages: async () => [],
      loadRefreshedSystemPromptParts: async () => ({
        promptContext: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      hasPendingUserMessage: true,
      promptContext: { cursor: null, messages: [] },
    }, {
      agent: {
        maxTurn: 7,
      },
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-test",
      },
    });

    await stream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0].stopWhen).toBeDefined();
  });

  it("creates an OpenAI provider from account provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        promptContext: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      hasPendingUserMessage: true,
      promptContext: { cursor: null, messages: [] },
    }, {
      provider: {
        openai: {
          apiKey: "openai-key",
          project: "project-id",
        },
      },
      model: {
        provider: "openai",
        modelId: "gpt-5.4",
      },
    });

    await stream.consumeStream();

    expect(googleModelMock).not.toHaveBeenCalled();
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "openai-key",
      project: "project-id",
    });
    expect(openAIModelMock).toHaveBeenCalledWith("gpt-5.4");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "openai", modelId: "gpt-5.4" },
    });
  });

  it("throws when model provider or provider apiKey is missing", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const session = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        promptContext: { cursor: null, messages: [] },
        system: [],
      }),
    } as never;
    const turn = {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      hasPendingUserMessage: true,
      promptContext: { cursor: null, messages: [] },
    } as never;

    expect(runAgentLoop(session, turn, {})).rejects.toThrow("config.model.provider is required");
    expect(runAgentLoop(session, turn, {
      model: {
        provider: "openai",
        modelId: "gpt-5.4",
      },
    })).rejects.toThrow("config.provider.openai is required");
    expect(runAgentLoop(session, turn, {
      provider: {
        openai: {},
      },
      model: {
        provider: "openai",
        modelId: "gpt-5.4",
      },
    })).rejects.toThrow("config.provider.openai.apiKey is required");
  });

  it("creates Bedrock and Gateway providers from account provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const baseSession = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        promptContext: { cursor: null, messages: [] },
        system: [],
      }),
    } as never;
    const turn = {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      hasPendingUserMessage: true,
      promptContext: { cursor: null, messages: [] },
    } as never;

    const bedrockStream = await runAgentLoop(baseSession, turn, {
      provider: {
        bedrock: {
          region: "us-east-1",
          apiKey: "bedrock-key",
        },
      },
      model: {
        provider: "bedrock",
        modelId: "amazon.nova-lite-v1:0",
      },
    });
    await bedrockStream.consumeStream();

    expect(createBedrockMock).toHaveBeenCalledWith({
      region: "us-east-1",
      apiKey: "bedrock-key",
    });
    expect(bedrockModelMock).toHaveBeenCalledWith("amazon.nova-lite-v1:0");

    streamTextMock.mockClear();

    const gatewayStream = await runAgentLoop(baseSession, turn, {
      provider: {
        gateway: {
          apiKey: "gateway-key",
        },
      },
      model: {
        provider: "gateway",
        modelId: "openai/gpt-5.4",
      },
    });
    await gatewayStream.consumeStream();

    expect(createGatewayMock).toHaveBeenCalledWith({
      apiKey: "gateway-key",
    });
    expect(gatewayModelMock).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "gateway", modelId: "openai/gpt-5.4" },
    });
  });
});

function installHarnessEnv(): void {
  process.env.MAX_AGENT_ITERATIONS = "3";
  process.env.TAVILY_API_KEY = "tavily-key";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
}
