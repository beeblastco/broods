/**
 * Agent harness tests.
 * Cover model-loop edge cases without calling provider APIs.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";
import { dynamo } from "../functions/_shared/storage/dynamo/client.ts";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const originalFetch = globalThis.fetch;
const originalDynamoSend = dynamo.send;
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
let streamTextScenario:
  | "empty"
  | "error-then-empty"
  | "error-no-finish"
  | "hard-throw"
  | "approval-request"
  | "structured-output"
  | "tool-run"
  | "multi-step-text" = "empty";

const streamTextMock = mock((options: {
  onStepStart?: (args: {
    stepNumber: number;
    model: { provider: string; modelId: string };
    messages: unknown[];
    tools?: Record<string, unknown>;
    activeTools?: string[];
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  onToolExecutionStart?: (args: {
    toolCall: { toolCallId: string; toolName: string; input?: unknown };
  }) => Promise<void>;
  onToolExecutionEnd?: (args: {
    toolCall: { toolCallId: string; toolName: string; input?: unknown };
    toolExecutionMs: number;
    toolOutput:
      | { type: "tool-result"; output: unknown }
      | { type: "tool-error"; error: unknown };
  }) => Promise<void>;
  onChunk?: unknown;
  onError(args: { error: unknown }): Promise<void>;
  onEnd(args: {
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
  onStepEnd?(args: {
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
    text?: string;
    reasoningText?: string;
  }): Promise<void>;
  output?: unknown;
  stopWhen?: unknown;
  instructions?: unknown;
  tools?: unknown;
  toolApproval?: unknown;
}) => {
  let consumed = false;
  const stream = new ReadableStream({
    async start(controller) {
      if (streamTextScenario === "hard-throw") {
        controller.error(new Error("stream transport failed"));
        return;
      }

      if (streamTextScenario === "error-then-empty") {
        await options.onError({ error: new Error("provider failed") });
        controller.enqueue({ type: "error", error: new Error("provider failed") });
      }

      if (streamTextScenario === "error-no-finish") {
        // Mimic the real AI SDK: a run that errors before any step completes (a
        // usage-limit error on the first model call) fires onError but SKIPS
        // onEnd, so a stream-draining caller never finalizes on its own.
        await options.onError({ error: new Error("provider failed") });
        controller.enqueue({ type: "error", error: new Error("provider failed") });
        controller.close();
        return;
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
        await options.onEnd({
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
        await options.onStepStart?.({
          stepNumber: 0,
          model: { provider: "google", modelId: "gemini-custom" },
          messages: [{ role: "user", content: "hello" }],
          tools: options.tools as Record<string, unknown> | undefined,
          metadata: { run: "test" },
        });
        await options.onStepEnd?.({
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
        await options.onEnd({
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
        await options.onStepStart?.({
          stepNumber: 0,
          model: { provider: "google", modelId: "gemini-custom" },
          messages: [{ role: "user", content: "hello" }],
          tools: options.tools as Record<string, unknown> | undefined,
          metadata: { run: "test" },
        });
        await options.onToolExecutionStart?.({
          toolCall,
        });
        await options.onToolExecutionEnd?.({
          toolCall,
          toolExecutionMs: 12,
          toolOutput: { type: "tool-result", output: { type: "text", value: "file.txt" } },
        });
        await options.onStepEnd?.({
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
        await options.onEnd({
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

      if (streamTextScenario === "multi-step-text") {
        await options.onStepEnd?.({
          stepNumber: 0,
          model: { provider: "google", modelId: "gemini-custom" },
          finishReason: "tool-calls",
          rawFinishReason: "TOOL_CALLS",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          toolCalls: [],
          toolResults: [],
          warnings: [],
          request: {},
          response: {
            messages: [{ role: "assistant", content: "Let me try again:" }],
            id: "response-1",
            modelId: "gemini-custom",
            timestamp: new Date("2024-01-02T03:04:05.000Z"),
          },
          text: "Let me try again:",
        });
        await options.onStepEnd?.({
          stepNumber: 1,
          model: { provider: "google", modelId: "gemini-custom" },
          finishReason: "stop",
          rawFinishReason: "STOP",
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          toolCalls: [],
          toolResults: [],
          warnings: [],
          request: {},
          response: {
            messages: [{ role: "assistant", content: "Final answer only." }],
            id: "response-2",
            modelId: "gemini-custom",
            timestamp: new Date("2024-01-02T03:04:06.000Z"),
          },
          text: "Final answer only.",
        });
        await options.onEnd({
          response: {
            messages: [{ role: "assistant", content: "Let me try again:\n\nFinal answer only." }],
            id: "response-2",
            modelId: "gemini-custom",
            timestamp: new Date("2024-01-02T03:04:06.000Z"),
          },
          text: "Let me try again:\n\nFinal answer only.",
          finishReason: "stop",
          rawFinishReason: "STOP",
          usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
          totalUsage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
          steps: [],
          toolCalls: [],
        });
        controller.enqueue({ type: "finish", finishReason: "stop" });
        controller.close();
        return;
      }

      await options.onEnd({
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
    stream,
    async consumeStream() {
      if (consumed) {
        return;
      }

      consumed = true;
      const reader = stream.getReader();
      while (!(await reader.read()).done) { }
    },
  };
});

mock.module("@ai-sdk/google", () => ({
  createGoogle: createGoogleMock,
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
  dynamo.send = originalDynamoSend;
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
    expect(typeof streamTextMock.mock.calls[0]?.[0].onChunk).toBe("function");
    expect(typeof streamTextMock.mock.calls[0]?.[0].onToolExecutionStart).toBe("function");
    expect(typeof streamTextMock.mock.calls[0]?.[0].onToolExecutionEnd).toBe("function");
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
        webhooks: [{
          enabled: true,
          url: "https://hooks.example/agent-events",
          secret: "hook-secret",
          events: ["agent.started", "agent.failed"],
        }],
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

  it("marks a hard stream termination as failed when no completion hook runs", async () => {
    streamTextScenario = "hard-throw";
    installHarnessEnv();
    process.env.USAGE_TABLE_NAME = "usage-test";
    const usageWrites: Array<{
      input?: { TransactItems?: Array<{ Put?: { Item?: Record<string, { S?: string }> } }> };
    }> = [];
    dynamo.send = mock(async (command: {
      input?: { TransactItems?: Array<{ Put?: { Item?: Record<string, { S?: string }> } }> };
    }) => {
      usageWrites.push(command);
      return {};
    }) as never;
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
      provider: { google: { apiKey: "google-key" } },
      model: { provider: "google", modelId: "gemini-test" },
    });

    await expect(stream.consumeStream()).rejects.toThrow("stream transport failed");
    expect(stream.didFail()).toBe(true);
    expect(stream.failureText()).toBe("stream transport failed");
    expect(usageWrites[0]?.input?.TransactItems?.[0]?.Put?.Item?.status?.S).toBe("failed");
  });

  it("finalizes via ensureFinalized when a caller drains stream and onEnd never fires", async () => {
    // The channel progress streamer reads stream directly instead of calling
    // consumeStream. When the model errors before any step completes (a usage-limit
    // error on the first call), the AI SDK fires onError but skips onEnd, so the
    // task would never finalize and its trace span would spin "running" forever.
    // ensureFinalized() is the safety net that path must call.
    streamTextScenario = "error-no-finish";
    installHarnessEnv();
    process.env.USAGE_TABLE_NAME = "usage-test";
    const usageWrites: Array<{
      input?: { TransactItems?: Array<{ Put?: { Item?: Record<string, { S?: string }> } }> };
    }> = [];
    dynamo.send = mock(async (command: {
      input?: { TransactItems?: Array<{ Put?: { Item?: Record<string, { S?: string }> } }> };
    }) => {
      usageWrites.push(command);
      return {};
    }) as never;
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
      provider: { google: { apiKey: "google-key" } },
      model: { provider: "google", modelId: "gemini-test" },
    }, {
      onFinalText: async () => { },
      onErrorText,
    });

    // Drain stream the way the channel streamer does (no consumeStream call).
    const reader = stream.stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    // onError ran during the drain, but nothing has finalized the task yet.
    expect(onErrorText).toHaveBeenCalledWith("provider failed");
    expect(usageWrites).toHaveLength(0);

    await stream.ensureFinalized();

    expect(stream.didFail()).toBe(true);
    expect(usageWrites[0]?.input?.TransactItems?.[0]?.Put?.Item?.status?.S).toBe("failed");

    // Idempotent: a second call (and any later consumeStream) writes nothing more.
    await stream.ensureFinalized();
    expect(usageWrites).toHaveLength(1);
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
    const toolApproval = streamTextMock.mock.calls[0]?.[0].toolApproval as (event: unknown) => Promise<unknown>;
    expect(typeof toolApproval).toBe("function");
    await expect(toolApproval({
      toolCall: { type: "tool-call", toolCallId: "t", toolName: "bash", input: {} },
      tools: streamTextMock.mock.calls[0]?.[0].tools,
      toolsContext: {},
      runtimeContext: {},
      messages: [],
    })).resolves.toBe("user-approval");
    expect(streamTextMock.mock.calls[0]?.[0].instructions).toEqual([]);
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
        reasoning: "low",
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
      // Unified v7 reasoning setting flows through as a plain model setting.
      reasoning: "low",
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

  it("uses the last non-empty step text for final channel output", async () => {
    streamTextScenario = "multi-step-text";
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
      },
    }, {
      onFinalText,
      onErrorText: async (error) => {
        throw new Error(error);
      },
    });

    await stream.consumeStream();

    expect(stream.finalResponse()).toBe("Final answer only.");
    expect(onFinalText).toHaveBeenCalledWith("Final answer only.");
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
      endpointId: "env-1234",
      projectSlug: "project-one",
      environmentSlug: "development",
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
      "model.step.started",
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
      accountId: "acct_test",
      endpointId: "env-1234",
    });
    const startedTraceId = logs.find((log) => log.eventType === "model.invocation.started").traceId;
    expect(logs.find((log) => log.eventType === "model.invocation.finished").traceId).toBe(startedTraceId);
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
