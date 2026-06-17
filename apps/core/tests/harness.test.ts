/**
 * Agent harness tests.
 * Cover model-loop edge cases without calling provider APIs.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const originalFetch = globalThis.fetch;
const googleModelMock = mock((modelId: string) => ({ provider: "google", modelId }));
const createGoogleMock = mock((_options: unknown) => googleModelMock);
const openAIModelMock = mock((modelId: string) => ({ provider: "openai", modelId }));
const createOpenAIMock = mock((_options: unknown) => openAIModelMock);
const anthropicModelMock = mock((modelId: string) => ({ provider: "anthropic", modelId }));
const createAnthropicMock = mock((_options: unknown) => anthropicModelMock);
const bedrockModelMock = mock((modelId: string) => ({ provider: "bedrock", modelId }));
const createBedrockMock = mock((_options: unknown) => bedrockModelMock);
const gatewayModelMock = mock((modelId: string) => ({ provider: "gateway", modelId }));
const createGatewayMock = mock((_options: unknown) => gatewayModelMock);
const minimaxModelMock = mock((modelId: string) => ({ provider: "minimax", modelId }));
const createMinimaxMock = mock((_options: unknown) => minimaxModelMock);
let streamTextScenario: "empty" | "error-then-empty" | "approval-request" | "structured-output" | "tool-run" = "empty";

const streamTextMock = mock((options: {
  experimental_onStepStart?: (args: {
    stepNumber: number;
    model: { provider: string; modelId: string };
    messages: unknown[];
    tools?: Record<string, unknown>;
    activeTools?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  experimental_onToolCallStart?: (args: {
    stepNumber?: number;
    toolCall: { toolCallId: string; toolName: string; input?: unknown };
  }) => Promise<void>;
  experimental_onToolCallFinish?: (args: {
    stepNumber?: number;
    toolCall: { toolCallId: string; toolName: string; input?: unknown };
    durationMs: number;
    success: boolean;
    error?: unknown;
  }) => Promise<void>;
  onChunk?: unknown;
  onError(args: { error: unknown }): Promise<void>;
  onFinish(args: {
    response: {
      messages: unknown[];
      id?: string;
      modelId?: string;
      timestamp?: Date;
      headers?: Record<string, string>;
    };
    text: string;
    finishReason: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    steps: Array<{ content: unknown[] }>;
    toolCalls: unknown[];
    rawFinishReason?: string;
    totalUsage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    request?: Record<string, unknown>;
    providerMetadata?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  onStepFinish?(args: {
    stepNumber: number;
    model: { provider: string; modelId: string };
    finishReason: string;
    rawFinishReason?: string;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
    toolCalls: unknown[];
    toolResults: unknown[];
    warnings?: unknown[];
    request: Record<string, unknown>;
    response: { messages: unknown[]; id: string; modelId: string; timestamp: Date; headers?: Record<string, string> };
    providerMetadata?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  output?: unknown;
  stopWhen?: unknown;
  system?: unknown;
  tools?: unknown;
}) => {
  let consumed = false;
  const fullStream = new ReadableStream({
    async start(controller) {
      if (streamTextScenario === "error-then-empty") {
        await options.onError({ error: new Error("provider failed") });
        controller.enqueue({ type: "error", error: new Error("provider failed") });
      }

      if (streamTextScenario === "approval-request") {
        const approvalPart = {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCall: {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { shell: "rm file.txt" },
          },
        };
        await options.onFinish({
          response: {
            messages: [{
              role: "assistant",
              content: [{
                type: "tool-approval-request",
                approvalId: "approval-1",
                toolCallId: "tool-call-1",
              }],
            }],
          },
          text: "   ",
          finishReason: "tool-calls",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          steps: [{ content: [approvalPart] }],
          toolCalls: [],
        });
        controller.enqueue({
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
        });
        controller.enqueue({ type: "finish", finishReason: "tool-calls" });
        controller.close();
        return;
      }

      if (streamTextScenario === "structured-output") {
        await options.experimental_onStepStart?.({
          stepNumber: 0,
          model: { provider: "google", modelId: "gemini-custom" },
          messages: [{ role: "user", content: "hello" }],
          tools: options.tools as Record<string, unknown> | undefined,
          metadata: { run: "test" },
        });
        await options.onStepFinish?.({
          stepNumber: 0,
          model: { provider: "google", modelId: "gemini-custom" },
          finishReason: "stop",
          rawFinishReason: "STOP",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          toolCalls: [],
          toolResults: [],
          warnings: [],
          request: {},
          response: {
            messages: [{ role: "assistant", content: "{\"answer\":\"done\"}" }],
            id: "response-1",
            modelId: "gemini-custom",
            timestamp: new Date("2024-01-02T03:04:05.000Z"),
            headers: {
              "x-request-id": "request-1",
              authorization: "redacted",
            },
          },
          providerMetadata: { google: { safetyRatings: [] } },
          metadata: { run: "test" },
        });
        await options.onFinish({
          response: {
            messages: [{ role: "assistant", content: "{\"answer\":\"done\"}" }],
            id: "response-1",
            modelId: "gemini-custom",
            timestamp: new Date("2024-01-02T03:04:05.000Z"),
            headers: {
              "x-request-id": "request-1",
              authorization: "redacted",
            },
          },
          text: "{\"answer\":\"done\"}",
          finishReason: "stop",
          rawFinishReason: "STOP",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          totalUsage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          steps: [],
          toolCalls: [],
          request: {},
          providerMetadata: { google: { safetyRatings: [] } },
          metadata: { run: "test" },
        });
        controller.enqueue({ type: "finish", finishReason: "stop" });
        controller.close();
        return;
      }

      if (streamTextScenario === "tool-run") {
        const toolCall = {
          type: "tool-call",
          toolCallId: "tool-call-1",
          toolName: "bash",
          input: { shell: "ls" },
        };
        await options.experimental_onStepStart?.({
          stepNumber: 0,
          model: { provider: "google", modelId: "gemini-custom" },
          messages: [{ role: "user", content: "hello" }],
          tools: options.tools as Record<string, unknown> | undefined,
          metadata: { run: "test" },
        });
        await options.experimental_onToolCallStart?.({
          stepNumber: 0,
          toolCall,
        });
        await options.experimental_onToolCallFinish?.({
          stepNumber: 0,
          toolCall,
          durationMs: 12,
          success: true,
        });
        await options.onStepFinish?.({
          stepNumber: 0,
          model: { provider: "google", modelId: "gemini-custom" },
          finishReason: "stop",
          rawFinishReason: "STOP",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          toolCalls: [toolCall],
          toolResults: [{
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "bash",
            output: { type: "text", value: "file.txt" },
          }],
          warnings: [],
          request: {},
          response: {
            messages: [{ role: "assistant", content: "done" }],
            id: "response-1",
            modelId: "gemini-custom",
            timestamp: new Date("2024-01-02T03:04:05.000Z"),
          },
          metadata: { run: "test" },
        });
        await options.onFinish({
          response: {
            messages: [{ role: "assistant", content: "done" }],
            id: "response-1",
            modelId: "gemini-custom",
            timestamp: new Date("2024-01-02T03:04:05.000Z"),
          },
          text: "done",
          finishReason: "stop",
          rawFinishReason: "STOP",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          totalUsage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          steps: [],
          toolCalls: [toolCall],
        });
        controller.enqueue({ type: "finish", finishReason: "stop" });
        controller.close();
        return;
      }

      await options.onFinish({
        response: { messages: [] },
        text: "   ",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
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

mock.module("@ai-sdk/anthropic", () => ({
  createAnthropic: createAnthropicMock,
}));

mock.module("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: createBedrockMock,
}));

mock.module("@ai-sdk/gateway", () => ({
  createGateway: createGatewayMock,
}));

mock.module("vercel-minimax-ai-provider", () => ({
  createMinimax: createMinimaxMock,
}));

mock.module("ai", () => ({
  ...actualAi,
  streamText: streamTextMock,
}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.stdout.write = ORIGINAL_STDOUT_WRITE;
  globalThis.fetch = originalFetch;
  streamTextScenario = "empty";
  streamTextMock.mockClear();
  googleModelMock.mockClear();
  createGoogleMock.mockClear();
  openAIModelMock.mockClear();
  createOpenAIMock.mockClear();
  anthropicModelMock.mockClear();
  createAnthropicMock.mockClear();
  bedrockModelMock.mockClear();
  createBedrockMock.mockClear();
  gatewayModelMock.mockClear();
  createGatewayMock.mockClear();
  minimaxModelMock.mockClear();
  createMinimaxMock.mockClear();
});

describe("runAgentLoop", () => {
  it("sends the error hook when the model finishes with empty text", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const persistModelMessages = mock(async () => { });
    const onErrorText = mock(async () => { });

    const stream = await runAgentLoop({
      conversationKey: "tg:7495331456",
      eventId: "tg:900151472",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages,
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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

  it("sends configured lifecycle webhooks for agent events", async () => {
    installHarnessEnv();
    const fetchMock = mock(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) =>
      new Response(null, { status: 200 })
    );
    globalThis.fetch = fetchMock as never;
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => [],
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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
      hooks: {
        webhook: {
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.started", "agent.failed"],
        },
      },
    });

    await stream.consumeStream();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payloads = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(payloads.map((payload) => payload.type)).toEqual(["agent.started", "agent.failed"]);
    expect(payloads[0]).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      eventId: "direct-event",
      conversationKey: "direct:conversation",
      payload: {
        modelProvider: "google",
        modelId: "gemini-test",
        messageCount: 1,
      },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://hooks.example/agent-events");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "Content-Type": "application/json",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty("X-Webhook-Signature");
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
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => [],
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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

  it("treats tool approval requests as pending work instead of empty responses", async () => {
    streamTextScenario = "approval-request";
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const persistModelMessages = mock(async () => { });
    const onErrorText = mock(async () => { });
    const onApprovalRequired = mock(async () => { });

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => ({ provider: "lambda" }),
      statelessPermissionMode: () => "ask",
      persistModelMessages,
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "delete a file" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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
      onApprovalRequired,
    });

    await stream.consumeStream();

    expect(stream.didFail()).toBe(false);
    expect(stream.failureText()).toBeNull();
    expect(stream.approvalSummaries()).toEqual([{
      approvalId: "approval-1",
      toolCallId: "tool-call-1",
      toolName: "bash",
      input: { shell: "rm file.txt" },
    }]);
    expect(onErrorText).not.toHaveBeenCalled();
    expect(onApprovalRequired).toHaveBeenCalledWith(stream.approvalSummaries());
    expect(persistModelMessages).toHaveBeenCalledWith([{
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool-call-1",
          toolName: "bash",
          input: { shell: "rm file.txt" },
        },
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
        },
      ],
    }]);
    // bash now sets a per-call needsApproval function (resolves the selected
    // workspace's mode); stateless "ask" => approval required.
    const bashNeedsApproval = (streamTextMock.mock.calls[0]?.[0].tools as {
      bash: { needsApproval: (input: unknown, options: unknown) => boolean | Promise<boolean> };
    }).bash.needsApproval;
    expect(typeof bashNeedsApproval).toBe("function");
    expect(await bashNeedsApproval({}, { toolCallId: "t", messages: [] })).toBe(true);
    expect(streamTextMock.mock.calls[0]?.[0].system).toEqual([]);
  });

  it("passes agent model config into streamText", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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
        providerOptions: {
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

  it("passes providerOptions through without custom thinking aliases", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-custom",
        providerOptions: {
          google: {
            thinkingConfig: {
              thinkingLevel: "high",
              thinkingBudget: 8192,
              includeThoughts: true,
            },
          },
        },
      },
    });

    await stream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: {
        google: {
          thinkingConfig: {
            thinkingLevel: "high",
            thinkingBudget: 8192,
            includeThoughts: true,
          },
        },
      },
    });
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("thinkingConfig");
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("thinkingEffort");
  });

  it("passes OpenAI and Anthropic providerOptions through directly", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const baseSession = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never;
    const turnContext = {
      messages: [{ role: "user" as const, content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    };

    const openAIStream = await runAgentLoop(baseSession, turnContext, {
      provider: {
        openai: {
          apiKey: "openai-key",
        },
      },
      model: {
        provider: "openai",
        modelId: "gpt-5-mini",
        providerOptions: {
          openai: {
            reasoningEffort: "high",
            reasoningSummary: "detailed",
          },
        },
      },
    });
    await openAIStream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      providerOptions: {
        openai: {
          reasoningEffort: "high",
          reasoningSummary: "detailed",
        },
      },
    });

    const anthropicStream = await runAgentLoop(baseSession, turnContext, {
      provider: {
        anthropic: {
          apiKey: "anthropic-key",
        },
      },
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
        providerOptions: {
          anthropic: {
            thinking: {
              type: "enabled",
              budgetTokens: 12000,
            },
            effort: "low",
          },
        },
      },
    });
    await anthropicStream.consumeStream();

    expect(streamTextMock.mock.calls[1]?.[0]).toMatchObject({
      providerOptions: {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: 12000,
          },
          effort: "low",
        },
      },
    });
  });

  it("passes MiniMax providerOptions through directly", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      provider: {
        minimax: {
          apiKey: "minimax-key",
        },
      },
      model: {
        provider: "minimax",
        modelId: "MiniMax-M3",
        providerOptions: {
          anthropic: {
            thinking: {
              type: "enabled",
              budgetTokens: 4096,
            },
          },
        },
      },
    });
    await stream.consumeStream();

    const args = streamTextMock.mock.calls[0]?.[0] as { providerOptions?: { anthropic?: Record<string, unknown> } };
    expect(args?.providerOptions?.anthropic).toMatchObject({
      thinking: { type: "enabled", budgetTokens: 4096 },
    });
    expect(args?.providerOptions?.anthropic).not.toHaveProperty("effort");
  });

  it("passes structured output config into streamText and returns parsed output", async () => {
    streamTextScenario = "structured-output";
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const onFinalText = mock(async (_response: unknown) => { });

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-custom",
        output: {
          type: "object",
          name: "Answer",
          schema: {
            type: "object",
            properties: {
              answer: { type: "string" },
            },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      },
    }, {
      onFinalText,
      onErrorText: async (error) => {
        throw new Error(error);
      },
    });

    await stream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0]).toHaveProperty("output");
    expect(stream.hasStructuredOutput()).toBe(true);
    expect(stream.finalResponse()).toEqual({ answer: "done" });
    expect(onFinalText).toHaveBeenCalledWith({ answer: "done" });
  });

  it("emits structured CloudWatch telemetry for model invocations and steps", async () => {
    streamTextScenario = "structured-output";
    installHarnessEnv();
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stdout.write;
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-custom",
      },
    });

    await stream.consumeStream();

    const logs = lines.map((line) => JSON.parse(line));
    expect(logs.map((log) => log.eventType).filter(Boolean)).toEqual([
      "model.invocation.started",
      "model.step.finished",
      "model.invocation.finished",
    ]);
    expect(logs.find((log) => log.eventType === "model.invocation.started")).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      modelProvider: "google",
      modelId: "gemini-custom",
      messageCount: 1,
      enabledTools: [],
    });
    expect(logs.find((log) => log.eventType === "model.step.finished")).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      modelProvider: "google",
      modelId: "gemini-custom",
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      responseMetadata: {
        id: "response-1",
        modelId: "gemini-custom",
        timestamp: "2024-01-02T03:04:05.000Z",
      },
      providerMetadata: {
        google: {
          safetyRatings: [],
        },
      },
    });
    expect(typeof logs.find((log) => log.eventType === "model.step.finished").durationMs).toBe("number");
    expect(logs.find((log) => log.eventType === "model.invocation.finished")).toMatchObject({
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
    });
    expect(logs.find((log) => log.eventType === "model.step.finished").responseMetadata).not.toHaveProperty("headers");
  });

  it("logs aggregate tool usage metadata for monitoring", async () => {
    streamTextScenario = "tool-run";
    installHarnessEnv();
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk.trim() : Buffer.from(chunk).toString("utf8").trim());
      return true;
    }) as typeof process.stdout.write;
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      provider: {
        google: {
          apiKey: "google-key",
        },
      },
      model: {
        provider: "google",
        modelId: "gemini-custom",
      },
    });

    await stream.consumeStream();

    const logs = lines.map((line) => JSON.parse(line));
    expect(logs.find((log) => log.eventType === "tool.call.finished")).toMatchObject({
      accountId: "acct_test",
      agentId: "agent_test",
      eventId: "direct-event",
      toolName: "bash",
      toolCallId: "tool-call-1",
      durationMs: 12,
    });
    expect(logs.find((log) => log.eventType === "model.invocation.finished")).toMatchObject({
      toolsUsed: ["bash"],
      toolUsage: {
        bash: 1,
      },
      toolCalls: [{
        toolCallId: "tool-call-1",
        toolName: "bash",
        stepNumber: 0,
        durationMs: 12,
        success: true,
      }],
    });
  });

  it("uses agent maxTurn for the model loop limit", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => [],
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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

  it("exposes skill tools only when skills are enabled", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const loadSkillPrompt = mock(async () => ({
      path: "acct_test/support-flow",
      loadedPaths: ["SKILL.md"],
      bytes: 120,
    }));

    const stream = await runAgentLoop({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => [],
      loadSkillPrompt,
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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

    const tools = streamTextMock.mock.calls[0]?.[0].tools as Record<string, {
      execute(input: unknown): Promise<unknown>;
      needsApproval?: boolean;
    }>;
    expect(tools.load_skill).toBeDefined();
    const loadSkillTool = tools.load_skill!;
    await expect(loadSkillTool.execute({
      path: "acct_test/support-flow",
      resources: [],
    })).resolves.toEqual({
      type: "text",
      value: "Loaded skill acct_test/support-flow: SKILL.md. No sandbox staging path is available for bundled helper files in this turn.",
    });
    expect(loadSkillPrompt).toHaveBeenCalledWith(["acct_test/support-flow"], "acct_test/support-flow", []);
  });

  it("does not expose load_skill when no skills are configured", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => [],
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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

  it("forwards turn ephemeral system messages into subagent dispatch", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const dispatchSubagents = mock(async () => ({
      tasks: [{
        taskId: "subagent_1",
        agentId: "virtual_subagent_1",
        name: "Virtual subagent",
        conversationKey: "subagent-subagent_1",
        statusPath: "/status/subagent_1?agentId=virtual_subagent_1",
        status: "running" as const,
      }],
    }));
    const ephemeralSystem = [{ role: "system" as const, content: "Use the request-local style." }];

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => [],
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "delegate this" }],
      system: ephemeralSystem,
      ephemeralSystem,
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      subagent: {
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
    }, undefined, {
      dispatchSubagents,
    });

    await stream.consumeStream();

    const tools = streamTextMock.mock.calls[0]?.[0].tools as Record<string, { execute(input: unknown, options: { messages: unknown[] }): Promise<unknown> }>;
    expect(tools.run_subagent).toBeDefined();
    await tools.run_subagent!.execute({
      tasks: [{ prompt: "research" }],
    }, {
      messages: [
        { role: "user", content: "parent" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "internal scratch work" },
            { type: "text", text: "waiting for subagents" },
          ],
        },
      ],
    });
    expect(dispatchSubagents).toHaveBeenCalledWith(
      [{ prompt: "research" }],
      [
        { role: "user", content: "parent" },
        {
          role: "assistant",
          content: [{ type: "text", text: "waiting for subagents" }],
        },
      ],
      ephemeralSystem,
    );
  });

  it("creates an OpenAI provider from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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

  it("creates an Anthropic provider from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      provider: {
        anthropic: {
          apiKey: "anthropic-key",
          baseURL: "https://api.anthropic.example/v1",
        },
      },
      model: {
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      },
    });

    await stream.consumeStream();

    expect(createAnthropicMock).toHaveBeenCalledWith({
      apiKey: "anthropic-key",
      baseURL: "https://api.anthropic.example/v1",
    });
    expect(anthropicModelMock).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    });
  });

  it("creates a MiniMax provider from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const stream = await runAgentLoop({
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never, {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    }, {
      provider: {
        minimax: {
          apiKey: "minimax-key",
          baseURL: "https://api.minimax.io/anthropic/v1",
        },
      },
      model: {
        provider: "minimax",
        modelId: "MiniMax-M3",
        temperature: 1,
      },
    });

    await stream.consumeStream();

    expect(createMinimaxMock).toHaveBeenCalledWith({
      apiKey: "minimax-key",
      baseURL: "https://api.minimax.io/anthropic/v1",
    });
    expect(minimaxModelMock).toHaveBeenCalledWith("MiniMax-M3");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "minimax", modelId: "MiniMax-M3" },
      temperature: 1,
    });
  });

  it("throws when model provider or provider apiKey is missing", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");
    const session = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never;
    const turn = {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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

  it("creates Bedrock and Gateway providers from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../functions/harness-processing/harness.ts");

    const baseSession = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      statelessSandbox: () => undefined,
      statelessPermissionMode: () => "ask",
      persistModelMessages: async () => { },
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never;
    const turn = {
      messages: [{ role: "user", content: "hello" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
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
        providerOptions: {
          openai: {
            reasoningEffort: "low",
          },
        },
      },
    });
    await gatewayStream.consumeStream();

    expect(createGatewayMock).toHaveBeenCalledWith({
      apiKey: "gateway-key",
    });
    expect(gatewayModelMock).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "gateway", modelId: "openai/gpt-5.4" },
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
    });
  });
});

function installHarnessEnv(): void {
  process.env.MAX_AGENT_ITERATIONS = "3";
  process.env.TAVILY_API_KEY = "tavily-key";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-results";
}
