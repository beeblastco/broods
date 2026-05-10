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
let streamTextScenario: "empty" | "error-then-empty" = "empty";

const streamTextMock = mock((options: {
  experimental_onToolCallStart?: unknown;
  experimental_onToolCallFinish?: unknown;
  onChunk?: unknown;
  onError(args: { error: unknown }): Promise<void>;
  onFinish(args: {
    response: { messages: unknown[] };
    text: string;
    finishReason: string;
    steps: unknown[];
    toolCalls: unknown[];
  }): Promise<void>;
  stopWhen?: unknown;
  tools?: unknown;
}) => {
  let consumed = false;
  const fullStream = new ReadableStream({
    async start(controller) {
      if (streamTextScenario === "error-then-empty") {
        await options.onError({ error: new Error("provider failed") });
        controller.enqueue({ type: "error", error: new Error("provider failed") });
      }

      await options.onFinish({
        response: { messages: [] },
        text: "   ",
        finishReason: "stop",
        steps: [],
        toolCalls: [],
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
  streamTextScenario = "empty";
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
    expect(stream.failureText()).toBe("Model returned empty response (finishReason: stop, steps: 0, toolCalls: 0)");
    expect(onErrorText).toHaveBeenCalledWith("Model returned empty response (finishReason: stop, steps: 0, toolCalls: 0)");
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("providerOptions");
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("onChunk");
    expect(typeof streamTextMock.mock.calls[0]?.[0].experimental_onToolCallStart).toBe("function");
    expect(typeof streamTextMock.mock.calls[0]?.[0].experimental_onToolCallFinish).toBe("function");
  });

  it("keeps the provider error when the stream also finishes with empty text", async () => {
    streamTextScenario = "error-then-empty";
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const onErrorText = mock(async () => { });

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
    expect(stream.failureText()).toBe("provider failed");
    expect(onErrorText).toHaveBeenCalledTimes(1);
    expect(onErrorText).toHaveBeenCalledWith("provider failed");
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

  it("exposes load_skill only when skills are enabled", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const loadSkillPrompt = mock(async () => ({
      skillPath: "acct_test/support-flow",
      loadedPaths: ["SKILL.md"],
      bytes: 120,
    }));

    const stream = await runAgentLoop({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      persistModelMessages: async () => [],
      loadSkillPrompt,
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
      skills: {
        enabled: true,
        allowed: ["acct_test/support-flow"],
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

    const tools = streamTextMock.mock.calls[0]?.[0].tools as Record<string, { execute(input: unknown): Promise<unknown> }>;
    expect(tools.load_skill).toBeDefined();
    const loadSkillTool = tools.load_skill!;
    await expect(loadSkillTool.execute({
      skillPath: "acct_test/support-flow",
      resources: [],
    })).resolves.toEqual({
      type: "text",
      value: "Loaded skill acct_test/support-flow: SKILL.md",
    });
    expect(loadSkillPrompt).toHaveBeenCalledWith("acct_test/support-flow", []);
  });

  it("does not expose load_skill when no skills are configured", async () => {
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
      skills: {
        enabled: true,
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

    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("tools");
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
