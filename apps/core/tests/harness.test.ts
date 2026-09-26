import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { TLS_CERT, TLS_KEY } from "./helpers/tls.ts";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { LanguageModel, ModelMessage, SystemModelMessage } from "ai";
import * as actualAi from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4StreamPart } from "@ai-sdk/provider";
import * as actualOpenAICompatible from "@ai-sdk/openai-compatible";
import type { AgentLoopStream } from "../src/harness/harness.ts";
import type { SystemContextSnapshot } from "../src/harness/session.ts";
import type { PinnedFetchTransport } from "../src/shared/http.ts";
import * as otel from "../src/shared/otel.ts";
import {
  setStorageForTests,
  type Storage,
  type TaskUsageInput,
} from "../src/shared/storage.ts";
import type {
  ResolvedAgentSandbox,
  ResolvedWorkspace,
} from "../src/shared/workspaces.ts";

// mock.module("ai") below patches the namespace binding, so hold the real one.
const realStreamText = actualAi.streamText;
const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);
const originalFetch = globalThis.fetch;
const googleModelMock = mock((modelId: string) => ({
  provider: "google",
  modelId: modelId,
}));
const createGoogleMock = mock((_options: unknown) => googleModelMock);
const openAIModelMock = mock((modelId: string) => ({
  provider: "openai",
  modelId: modelId,
}));
const openAIChatModelMock = mock((modelId: string) => ({
  provider: "custom.chat",
  modelId: modelId,
}));
const openAIProviderMock = Object.assign(openAIModelMock, {
  chat: openAIChatModelMock,
});
const createOpenAIMock = mock((_options: unknown) => openAIProviderMock);
const openAICompatibleModelMock = mock((modelId: string) => ({
  provider: "custom.chat",
  modelId: modelId,
}));
const createOpenAICompatibleMock = mock(
  (_options: unknown) => openAICompatibleModelMock,
);
const anthropicModelMock = mock((modelId: string) => ({
  provider: "anthropic",
  modelId: modelId,
}));
const createAnthropicMock = mock((_options: unknown) => anthropicModelMock);
const bedrockModelMock = mock((modelId: string) => ({
  provider: "bedrock",
  modelId: modelId,
}));
const createBedrockMock = mock((_options: unknown) => bedrockModelMock);
const gatewayModelMock = mock((modelId: string) => ({
  provider: "vercel",
  modelId: modelId,
}));
const createGatewayMock = mock((_options: unknown) => gatewayModelMock);
const minimaxModelMock = mock((modelId: string) => ({
  provider: "minimax",
  modelId: modelId,
}));
const createMinimaxMock = mock((_options: unknown) => minimaxModelMock);
let streamTextScenario:
  | "empty"
  | "error-then-empty"
  | "error-no-finish"
  | "hard-throw"
  | "approval-request"
  | "automatic-approval"
  | "structured-output"
  | "tool-run"
  | "delivery-tool-then-empty"
  | "multi-step-text"
  | "real-two-step" = "empty";
// The model the last "real-two-step" run was given, so a test can read its calls.
let twoStepModelInUse: MockLanguageModelV4 | undefined;

const weatherTool = actualAi.tool({
  inputSchema: actualAi.jsonSchema<{ city: string }>({
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  }),
  execute: async ({ city }): Promise<{ city: string; tempC: number }> => ({
    city: city,
    tempC: 31,
  }),
});

const streamTextMock = mock(
  (options: {
    messages: ModelMessage[];
    model: LanguageModel;
    prepareStep?: (args: {
      messages: unknown[];
      responseMessages: unknown[];
    }) => Promise<{
      instructions?: unknown;
      messages?: unknown[];
    }>;
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
      response?: { id: string; modelId: string; timestamp: Date };
      responseMessages: unknown[];
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
      response: {
        messages: unknown[];
        id: string;
        modelId: string;
        timestamp: Date;
        headers?: Record<string, string>;
      };
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
    if (streamTextScenario === "real-two-step") {
      twoStepModelInUse = twoStepModel();

      return realStreamText({
        ...(options as Parameters<typeof realStreamText>[0]),
        model: twoStepModelInUse,
        tools: { weather: weatherTool },
      });
    }

    let consumed = false;
    const stream = new ReadableStream({
      start: async function (controller) {
        if (streamTextScenario === "hard-throw") {
          controller.error(new Error("stream transport failed"));

          return;
        }

        if (streamTextScenario === "error-then-empty") {
          await options.onError({ error: new Error("provider failed") });
          controller.enqueue({
            type: "error",
            error: new Error("provider failed"),
          });
        }

        if (streamTextScenario === "error-no-finish") {
          // Mimic the real AI SDK: a run that errors before any step completes (a
          // usage-limit error on the first model call) fires onError but SKIPS
          // onEnd, so a stream-draining caller never finalizes on its own.
          await options.onError({ error: new Error("provider failed") });
          controller.enqueue({
            type: "error",
            error: new Error("provider failed"),
          });
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
            responseMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-approval-request",
                    approvalId: "approval-1",
                    toolCallId: "tool-call-1",
                  },
                ],
              },
            ],
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

        // A policy decision the SDK resolved itself: the request part is a record
        // of an answered question, and its response ships in the same run.
        if (streamTextScenario === "automatic-approval") {
          const approvalPart = {
            type: "tool-approval-request",
            approvalId: "approval-auto-1",
            isAutomatic: true,
            toolCall: {
              type: "tool-call",
              toolCallId: "tool-call-1",
              toolName: "bash",
              input: { shell: "ls" },
            },
          };
          await options.onEnd({
            responseMessages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool-call",
                    toolCallId: "tool-call-1",
                    toolName: "bash",
                    input: { shell: "ls" },
                  },
                  {
                    type: "tool-approval-request",
                    approvalId: "approval-auto-1",
                    toolCallId: "tool-call-1",
                  },
                ],
              },
            ],
            text: "listed the files",
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            steps: [{ content: [approvalPart] }],
            toolCalls: [],
          });
          controller.enqueue({ type: "text-delta", text: "listed the files" });
          controller.enqueue({ type: "finish", finishReason: "stop" });
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
              messages: [{ role: "assistant", content: '{"answer":"done"}' }],
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
            // Structured output parsing reads the response metadata.
            response: {
              id: "response-1",
              modelId: "gemini-custom",
              timestamp: new Date("2024-01-02T03:04:05.000Z"),
            },
            responseMessages: [
              { role: "assistant", content: '{"answer":"done"}' },
            ],
            text: '{"answer":"done"}',
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
            toolCall: toolCall,
          });
          await options.onToolExecutionEnd?.({
            toolCall: toolCall,
            toolExecutionMs: 12,
            toolOutput: {
              type: "tool-result",
              output: { type: "text", value: "file.txt" },
            },
          });
          await options.onStepEnd?.({
            stepNumber: 0,
            model: { provider: "google", modelId: "gemini-custom" },
            finishReason: "stop",
            rawFinishReason: "STOP",
            usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
            toolCalls: [toolCall],
            toolResults: [
              {
                type: "tool-result",
                toolCallId: "tool-call-1",
                toolName: "bash",
                output: { type: "text", value: "file.txt" },
              },
            ],
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
            responseMessages: [{ role: "assistant", content: "done" }],
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

        // A gemini-flash-shaped run: the answer left through a delivery tool,
        // then the model stopped with no final text.
        if (streamTextScenario === "delivery-tool-then-empty") {
          const toolCall = {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "send-message",
            input: { conversationKey: "acct:test:other", message: "hi" },
          };
          await options.onToolExecutionStart?.({
            toolCall: toolCall,
          });
          await options.onToolExecutionEnd?.({
            toolCall: toolCall,
            toolExecutionMs: 12,
            toolOutput: {
              type: "tool-result",
              output: { type: "text", value: "Message queued." },
            },
          });
          await options.onEnd({
            responseMessages: [],
            text: "",
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
            responseMessages: [
              {
                role: "assistant",
                content: "Let me try again:\n\nFinal answer only.",
              },
            ],
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
          responseMessages: [],
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
      stream: stream,
      consumeStream: async function () {
        if (consumed) {
          return;
        }

        consumed = true;
        const reader = stream.getReader();
        while (!(await reader.read()).done) {}
      },
    };
  },
);

mock.module("@ai-sdk/google", () => ({
  createGoogle: createGoogleMock,
  createGoogleGenerativeAI: createGoogleMock,
}));

mock.module("@ai-sdk/openai", () => ({
  createOpenAI: createOpenAIMock,
}));

// Keep the real named exports: the openai-compatible provider packages
// (togetherai, cerebras, ...) import OpenAICompatibleChatLanguageModel from
// this module, and a mock that drops them breaks every import of provider.ts.
mock.module("@ai-sdk/openai-compatible", () => ({
  ...actualOpenAICompatible,
  createOpenAICompatible: createOpenAICompatibleMock,
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

beforeEach(() => {
  setStorageForTests(usageStorage([]));
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.stdout.write = ORIGINAL_STDOUT_WRITE;
  globalThis.fetch = originalFetch;
  setStorageForTests(null);
  streamTextScenario = "empty";
  streamTextMock.mockClear();
  googleModelMock.mockClear();
  createGoogleMock.mockClear();
  openAIModelMock.mockClear();
  openAIChatModelMock.mockClear();
  createOpenAIMock.mockClear();
  openAICompatibleModelMock.mockClear();
  createOpenAICompatibleMock.mockClear();
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
  it("injects durable steering only through the next AI SDK prepareStep boundary", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const appendIngressEvents = mock(async () => []);
    const applySteeringIngress = mock(async () => ({
      eventId: "owner",
      events: [{ role: "user", content: "new direction" }],
      delivery: { kind: "http" },
      requestedMode: "steer",
      appliedMode: "steer",
      appliedToEventId: "owner",
      contributingEventIds: ["steer-1"],
      ownerGeneration: 3,
    }));
    const stream = await runAgentLoop(
      {
        conversationKey: "acct:test:agent:test:api:conversation",
        eventId: "owner",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        renewConversationLease: async () => "renewed",
        applySteeringIngress: applySteeringIngress,
        appendIngressEvents: appendIngressEvents,
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "original" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: { google: { apiKey: "google-key" } },
        model: { provider: "google", modelId: "gemini-test" },
      },
    );

    const prepareStep = streamTextMock.mock.calls.at(-1)?.[0].prepareStep;
    expect(prepareStep).toBeFunction();
    const prepared = await prepareStep!({
      responseMessages: [],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "bash",
              input: {},
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "bash",
              output: { type: "text", value: "done" },
            },
          ],
        },
      ],
    });
    expect(prepared.messages?.at(-1)).toEqual({
      role: "user",
      content: "new direction",
    });
    expect(applySteeringIngress).toHaveBeenCalledTimes(1);
    expect(appendIngressEvents).toHaveBeenCalledWith([
      { role: "user", content: "new direction" },
    ]);
    await stream.consumeStream();
  });

  it("stops before the next model call when the owner requests a boundary stop, even if the same step's persist fails", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const appendIngressEvents = mock(async () => []);
    await runAgentLoop(
      {
        conversationKey: "acct:test:agent:test:api:conversation",
        eventId: "owner",
        appendIngressEvents: appendIngressEvents,
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async (): Promise<string[]> => {
          throw new Error("persist failed");
        },
        renewConversationLease: async () => "stopped",
        applySteeringIngress: async () => ({
          events: [{ role: "user", content: "late steer" }],
          contributingEventIds: ["steer"],
          appliedMode: "steer",
        }),
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "original" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: { google: { apiKey: "google-key" } },
        model: { provider: "google", modelId: "gemini-test" },
      },
    );

    const prepareStep = streamTextMock.mock.calls.at(-1)?.[0].prepareStep;
    await expect(
      prepareStep!({
        responseMessages: [],
        messages: [{ role: "user", content: "original" }],
      }),
    ).rejects.toThrow("Stopped by user at the model boundary");
    expect(appendIngressEvents).not.toHaveBeenCalled();
  });

  it("stores every step of a tool turn", async () => {
    installHarnessEnv();
    streamTextScenario = "real-two-step";
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const persisted: ModelMessage[] = [];
    const persistModelMessages = mock(
      async (messages: ModelMessage[]): Promise<string[]> => {
        persisted.push(...messages);

        return [];
      },
    );

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: persistModelMessages,
        renewConversationLease: async () => "renewed",
        applySteeringIngress: async () => null,
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "weather in Hanoi?" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: { google: { apiKey: "google-key" } },
        model: { provider: "google", modelId: "gemini-test" },
      },
      { onFinalText: async () => {}, onErrorText: async () => {} },
    );
    await stream.consumeStream();

    expect(stream.didFail()).toBe(false);
    expect(persisted.map((message): string => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    const first = persisted[0]?.content;
    expect(
      Array.isArray(first) && first.some((part) => part.type === "tool-call"),
    ).toBe(true);
    // prepareStep stored the first step before the second model call; onEnd
    // stored only what was left.
    expect(
      persistModelMessages.mock.calls.map((call) => call[0].length),
    ).toEqual([0, 2, 1]);
  });

  it("aborts and fails the run when the caller stops reading", async () => {
    const { readAgentFullStream } = await import("../src/harness/harness.ts");
    const stream = await startTwoStepTurn();
    // Leave while step 0's provider call is still streaming.
    for await (const chunk of readAgentFullStream(stream)) {
      if ((chunk as { type?: string }).type === "text-delta") break;
    }

    expect(stream.didFail()).toBe(true);
    expect(stream.failureText()).toBe("Caller stopped reading the stream");
    // The abort reached the provider call, and the second step never started.
    expect(twoStepModelInUse?.doStreamCalls).toHaveLength(1);
    expect(twoStepModelInUse?.doStreamCalls[0]?.abortSignal?.aborted).toBe(
      true,
    );
  });

  it("keeps the run alive when a reader that drains on its own leaves early", async () => {
    const { readAgentFullStream } = await import("../src/harness/harness.ts");
    const stream = await startTwoStepTurn();
    // A channel adapter that cannot post the stream: it stops on the first
    // delta and hands the reply back, then the caller drains what is left.
    for await (const chunk of readAgentFullStream(stream, false)) {
      if ((chunk as { type?: string }).type === "text-delta") break;
    }
    await stream.consumeStream();

    expect(stream.didFail()).toBe(false);
    expect(twoStepModelInUse?.doStreamCalls).toHaveLength(2);
  });

  it("keeps a finished run completed when the reader leaves during onEnd", async () => {
    const writes: TaskUsageInput[] = [];
    setStorageForTests(usageStorage(writes));
    const { readAgentFullStream } = await import("../src/harness/harness.ts");
    // A slow store keeps onEnd running after the last chunk is out.
    const stream = await startTwoStepTurn(async (): Promise<string[]> => {
      await Bun.sleep(30);

      return [];
    });
    for await (const chunk of readAgentFullStream(stream)) {
      if ((chunk as { type?: string }).type === "finish") break;
    }

    expect(stream.didFail()).toBe(false);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ status: "completed", stepCount: 2 });
  });

  it("settles the usage write before flushing telemetry", async () => {
    const order: string[] = [];
    const store = usageStorage([]);
    store.taskUsage.record = async function (): Promise<void> {
      await Bun.sleep(30);
      order.push("usage");
    };
    setStorageForTests(store);
    const flush = spyOn(otel, "forceFlushOtel").mockImplementation(
      async (): Promise<void> => {
        order.push("flush");
      },
    );
    try {
      const stream = await startTwoStepTurn();
      await stream.consumeStream();
    } finally {
      flush.mockRestore();
    }

    expect(order).toEqual(["usage", "flush"]);
  });

  it("meters the steps an aborted run finished", async () => {
    const writes: TaskUsageInput[] = [];
    setStorageForTests(usageStorage(writes));
    const { readAgentFullStream } = await import("../src/harness/harness.ts");
    const stream = await startTwoStepTurn();
    // Leave when step 1 opens: step 0 has ended, step 1's answer is 20 ms away.
    let stepsStarted = 0;
    for await (const chunk of readAgentFullStream(stream)) {
      if ((chunk as { type?: string }).type !== "start-step") continue;
      stepsStarted += 1;
      if (stepsStarted === 2) break;
    }

    expect(stream.didFail()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      status: "failed",
      stepCount: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("sends the error hook when the model finishes with empty text", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const persistModelMessages = mock(async () => {});
    const onErrorText = mock(async () => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "tg:7495331456",
        eventId: "tg:900151472",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: persistModelMessages,
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          google: {
            apiKey: "google-key",
          },
        },
        model: {
          provider: "google",
          modelId: "gemini-test",
        },
      },
      {
        onFinalText: async () => {
          throw new Error("unexpected final text");
        },
        onErrorText: onErrorText,
      },
    );

    await stream.consumeStream();

    expect(stream.didFail()).toBe(true);
    expect(stream.failureText()).toBe(
      "Model returned empty response (finishReason: stop, steps: 0, toolCalls: 0)",
    );
    expect(onErrorText).toHaveBeenCalledWith(
      "Model returned empty response (finishReason: stop, steps: 0, toolCalls: 0)",
    );
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("tools");
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "providerOptions",
    );
    expect(typeof streamTextMock.mock.calls[0]?.[0].onChunk).toBe("function");
    expect(typeof streamTextMock.mock.calls[0]?.[0].onToolExecutionStart).toBe(
      "function",
    );
    expect(typeof streamTextMock.mock.calls[0]?.[0].onToolExecutionEnd).toBe(
      "function",
    );
  });

  it("finishes cleanly when a delivery tool succeeded and the final text is empty", async () => {
    installHarnessEnv();
    streamTextScenario = "delivery-tool-then-empty";
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const onFinalText = mock(async () => {});
    const onErrorText = mock(async () => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "tg:7495331456",
        eventId: "tg:900151472",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          google: {
            apiKey: "google-key",
          },
        },
        model: {
          provider: "google",
          modelId: "gemini-test",
        },
      },
      {
        onFinalText: onFinalText,
        onErrorText: onErrorText,
      },
    );

    await stream.consumeStream();

    expect(stream.didFail()).toBe(false);
    expect(onErrorText).not.toHaveBeenCalled();
    expect(onFinalText).toHaveBeenCalledWith("");
  });

  it("sends configured lifecycle webhooks for agent events", async () => {
    installHarnessEnv();
    // Delivery opens its own pinned socket, so it is steered by resolving the
    // hook's name to the loopback the test server listens on rather than by
    // replacing a global.
    const delivered: HookDelivery[] = [];
    const { server, port } = await startHookServer(delivered);
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        accountId: "acct_test",
        agentId: "agent_test",
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
          webhooks: [
            {
              enabled: true,
              url: `https://public.test:${port}/agent-events`,
              secret: "hook-secret",
              events: ["agent.started", "agent.failed"],
            },
          ],
        },
      },
      undefined,
      { webhookTransport: hookTransport() },
    );

    await stream.consumeStream();
    server.close();

    expect(delivered).toHaveLength(2);
    const payloads = delivered.map((entry) => JSON.parse(entry.body));
    expect(payloads.map((payload) => payload.type)).toEqual([
      "agent.started",
      "agent.failed",
    ]);
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
    expect(delivered[0]?.path).toBe("/agent-events");
    expect(delivered[0]?.contentType).toBe("application/json");
    expect(delivered[0]?.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("keeps the provider error when the stream also finishes with empty text", async () => {
    streamTextScenario = "error-then-empty";
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const onErrorText = mock(async () => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          google: {
            apiKey: "google-key",
          },
        },
        model: {
          provider: "google",
          modelId: "gemini-test",
        },
      },
      {
        onFinalText: async () => {
          throw new Error("unexpected final text");
        },
        onErrorText: onErrorText,
      },
    );

    await stream.consumeStream();

    expect(stream.didFail()).toBe(true);
    expect(stream.failureText()).toBe("provider failed");
    expect(onErrorText).toHaveBeenCalledTimes(1);
    expect(onErrorText).toHaveBeenCalledWith("provider failed");
  });

  it("marks a hard stream termination as failed when no completion hook runs", async () => {
    streamTextScenario = "hard-throw";
    installHarnessEnv();
    const usageWrites: TaskUsageInput[] = [];
    setStorageForTests(usageStorage(usageWrites));
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: { google: { apiKey: "google-key" } },
        model: { provider: "google", modelId: "gemini-test" },
      },
    );

    await expect(stream.consumeStream()).rejects.toThrow(
      "stream transport failed",
    );
    expect(stream.didFail()).toBe(true);
    expect(stream.failureText()).toBe("stream transport failed");
    expect(usageWrites[0]?.status).toBe("failed");
  });

  it("finalizes via ensureFinalized when a caller drains stream and onEnd never fires", async () => {
    // The channel progress streamer reads stream directly instead of calling
    // consumeStream. When the model errors before any step completes (a usage-limit
    // error on the first call), the AI SDK fires onError but skips onEnd, so the
    // task would never finalize and its trace span would spin "running" forever.
    // ensureFinalized() is the safety net that path must call.
    streamTextScenario = "error-no-finish";
    installHarnessEnv();
    const usageWrites: TaskUsageInput[] = [];
    setStorageForTests(usageStorage(usageWrites));
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const onErrorText = mock(async () => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: { google: { apiKey: "google-key" } },
        model: { provider: "google", modelId: "gemini-test" },
      },
      {
        onFinalText: async () => {},
        onErrorText: onErrorText,
      },
    );

    // Drain stream the way the channel streamer does (no consumeStream call).
    const reader = stream.stream.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }

    // onError ran during the drain, but nothing has finalized the task yet.
    expect(onErrorText).toHaveBeenCalledWith("provider failed");
    expect(usageWrites).toHaveLength(0);

    await stream.ensureFinalized(true);

    expect(stream.didFail()).toBe(true);
    expect(usageWrites[0]?.status).toBe("failed");

    // Idempotent: a second call (and any later consumeStream) writes nothing more.
    await stream.ensureFinalized(true);
    expect(usageWrites).toHaveLength(1);
  });

  it("treats tool approval requests as pending work instead of empty responses", async () => {
    streamTextScenario = "approval-request";
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const persistModelMessages = mock(async () => {});
    const onErrorText = mock(async () => {});
    const onApprovalRequired = mock(async () => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: (): ResolvedAgentSandbox[] => [
          {
            name: "agent-sandbox",
            sandbox: { provider: "lambda", permissionMode: "ask" },
          },
        ],
        environmentText: () => "<environment>",
        persistModelMessages: persistModelMessages,
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "delete a file" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          google: {
            apiKey: "google-key",
          },
        },
        model: {
          provider: "google",
          modelId: "gemini-test",
        },
      },
      {
        onFinalText: async () => {
          throw new Error("unexpected final text");
        },
        onErrorText: onErrorText,
        onApprovalRequired: onApprovalRequired,
      },
    );

    await stream.consumeStream();

    expect(stream.didFail()).toBe(false);
    expect(stream.failureText()).toBeNull();
    expect(stream.approvalSummaries()).toEqual([
      {
        approvalId: "approval-1",
        toolCallId: "tool-call-1",
        toolName: "bash",
        input: { shell: "rm file.txt" },
      },
    ]);
    expect(onErrorText).not.toHaveBeenCalled();
    expect(onApprovalRequired).toHaveBeenCalledWith(stream.approvalSummaries());
    expect(persistModelMessages).toHaveBeenCalledWith([
      {
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
      },
    ]);
    const toolApproval = streamTextMock.mock.calls[0]?.[0].toolApproval as (
      event: unknown,
    ) => Promise<unknown>;
    expect(typeof toolApproval).toBe("function");
    await expect(
      toolApproval({
        toolCall: {
          type: "tool-call",
          toolCallId: "t",
          toolName: "bash",
          input: {},
        },
        tools: streamTextMock.mock.calls[0]?.[0].tools,
        toolsContext: {},
        runtimeContext: {},
        messages: [],
      }),
    ).resolves.toBe("user-approval");
    expect(streamTextMock.mock.calls[0]?.[0].instructions).toEqual([]);
  });

  it("does not gate the turn on approvals the SDK already resolved", async (): Promise<void> => {
    streamTextScenario = "automatic-approval";
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const persistModelMessages = mock(async (): Promise<void> => {});
    const onErrorText = mock(async (): Promise<void> => {});
    const onApprovalRequired = mock(async (): Promise<void> => {});
    const onFinalText = mock(async (): Promise<void> => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: (): string => "fs-test",
        resolvedWorkspaces: (): ResolvedWorkspace[] => [],
        sandboxes: (): ResolvedAgentSandbox[] => [
          {
            name: "agent-sandbox",
            sandbox: { provider: "lambda", permissionMode: "bypass" },
          },
        ],
        environmentText: () => "<environment>",
        persistModelMessages: persistModelMessages,
        loadRefreshedSystemPromptParts: async (): Promise<{
          systemContextSnapshot: SystemContextSnapshot;
          system: SystemModelMessage[];
        }> => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "list the files" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: { google: { apiKey: "google-key" } },
        model: { provider: "google", modelId: "gemini-test" },
      },
      {
        onFinalText: onFinalText,
        onErrorText: onErrorText,
        onApprovalRequired: onApprovalRequired,
      },
    );

    await stream.consumeStream();

    // An automatic request must not read as pending: on a channel turn that
    // would persist a denial for an answered approvalId, and the next model call
    // rejects the history with AI_InvalidToolApprovalError.
    expect(stream.approvalSummaries()).toEqual([]);
    expect(onApprovalRequired).not.toHaveBeenCalled();
    expect(onErrorText).not.toHaveBeenCalled();
    expect(stream.didFail()).toBe(false);
    expect(onFinalText).toHaveBeenCalled();
    // The request part still belongs in history so the SDK can pair it later.
    expect(persistModelMessages).toHaveBeenCalledWith([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { shell: "ls" },
          },
          {
            type: "tool-approval-request",
            approvalId: "approval-auto-1",
            toolCallId: "tool-call-1",
          },
        ],
      },
    ]);
  });

  it("passes agent model config into streamText", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

    await stream.consumeStream();

    expect(googleModelMock).toHaveBeenCalledWith("gemini-custom");
    expect(createGoogleMock).toHaveBeenCalledWith({
      apiKey: "google-key",
      fetch: expect.any(Function),
    });
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
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

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
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "thinkingConfig",
    );
    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "thinkingEffort",
    );
  });

  it("passes OpenAI and Anthropic providerOptions through directly", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const baseSession = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      sandboxes: () => [],
      environmentText: () => "<environment>",
      persistModelMessages: async () => {},
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
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );
    await stream.consumeStream();

    const args = streamTextMock.mock.calls[0]?.[0] as {
      providerOptions?: { anthropic?: Record<string, unknown> };
    };
    expect(args?.providerOptions?.anthropic).toMatchObject({
      thinking: { type: "enabled", budgetTokens: 4096 },
    });
    expect(args?.providerOptions?.anthropic).not.toHaveProperty("effort");
  });

  it("passes structured output config into streamText and returns parsed output", async () => {
    streamTextScenario = "structured-output";
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const onFinalText = mock(async (_response: unknown) => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
      {
        onFinalText: onFinalText,
        onErrorText: async (error) => {
          throw new Error(error);
        },
      },
    );

    await stream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0]).toHaveProperty("output");
    expect(stream.hasStructuredOutput()).toBe(true);
    expect(stream.finalResponse()).toEqual({ answer: "done" });
    expect(onFinalText).toHaveBeenCalledWith({ answer: "done" });
  });

  it("uses the last non-empty step text for final channel output", async () => {
    streamTextScenario = "multi-step-text";
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const onFinalText = mock(async (_response: unknown) => {});

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          google: {
            apiKey: "google-key",
          },
        },
        model: {
          provider: "google",
          modelId: "gemini-custom",
        },
      },
      {
        onFinalText: onFinalText,
        onErrorText: async (error) => {
          throw new Error(error);
        },
      },
    );

    await stream.consumeStream();

    expect(stream.finalResponse()).toBe("Final answer only.");
    expect(onFinalText).toHaveBeenCalledWith("Final answer only.");
  });

  it("emits structured CloudWatch telemetry for model invocations and steps", async () => {
    streamTextScenario = "structured-output";
    installHarnessEnv();
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );

      return true;
    }) as typeof process.stdout.write;
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        accountId: "acct_test",
        agentId: "agent_test",
        endpointId: "env-1234",
        projectSlug: "project-one",
        stageSlug: "development",
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          google: {
            apiKey: "google-key",
          },
        },
        model: {
          provider: "google",
          modelId: "gemini-custom",
        },
      },
    );

    await stream.consumeStream();

    const logs = lines.map((line) => JSON.parse(line));
    expect(logs.map((log) => log.eventType).filter(Boolean)).toEqual([
      "model.invocation.started",
      "model.step.finished",
      "model.invocation.finished",
    ]);
    expect(
      logs.find((log) => log.eventType === "model.invocation.started"),
    ).toMatchObject({
      message:
        "Agent loop started: google/gemini-custom with 1 message(s), 0 tool(s)",
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      modelProvider: "google",
      modelId: "gemini-custom",
      messageCount: 1,
      enabledTools: [],
    });
    expect(
      logs.find((log) => log.eventType === "model.step.finished"),
    ).toMatchObject({
      message: expect.stringContaining(
        "Agent step 0 finished: stop, 0 tool call(s), 4 in / 6 out / 10 total token(s),",
      ),
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
    expect(
      typeof logs.find((log) => log.eventType === "model.step.finished")
        .durationMs,
    ).toBe("number");
    expect(
      logs.find((log) => log.eventType === "model.invocation.finished"),
    ).toMatchObject({
      message: expect.stringContaining(
        "Model invocation finished: stop, 0 step(s), 0 tool call(s), 4 in / 6 out / 10 total token(s),",
      ),
      usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
      accountId: "acct_test",
      endpointId: "env-1234",
    });
    const startedTraceId = logs.find(
      (log) => log.eventType === "model.invocation.started",
    ).traceId;
    expect(
      logs.find((log) => log.eventType === "model.invocation.finished").traceId,
    ).toBe(startedTraceId);
    expect(
      logs.find((log) => log.eventType === "model.step.finished")
        .responseMetadata,
    ).not.toHaveProperty("headers");
  });

  it("logs aggregate tool usage metadata for monitoring", async () => {
    streamTextScenario = "tool-run";
    installHarnessEnv();
    const lines: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(
        typeof chunk === "string"
          ? chunk.trim()
          : Buffer.from(chunk).toString("utf8").trim(),
      );

      return true;
    }) as typeof process.stdout.write;
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        accountId: "acct_test",
        agentId: "agent_test",
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          google: {
            apiKey: "google-key",
          },
        },
        model: {
          provider: "google",
          modelId: "gemini-custom",
        },
      },
    );

    await stream.consumeStream();

    const logs = lines.map((line) => JSON.parse(line));
    expect(
      logs.find((log) => log.eventType === "tool.call.finished"),
    ).toMatchObject({
      message: "Tool call finished: bash in 12ms",
      accountId: "acct_test",
      agentId: "agent_test",
      eventId: "direct-event",
      toolName: "bash",
      toolCallId: "tool-call-1",
      durationMs: 12,
    });
    expect(
      logs.find((log) => log.eventType === "model.invocation.finished"),
    ).toMatchObject({
      toolsUsed: ["bash"],
      toolUsage: {
        bash: 1,
      },
      toolCalls: [
        {
          toolCallId: "tool-call-1",
          toolName: "bash",
          stepNumber: 0,
          durationMs: 12,
          success: true,
        },
      ],
    });
  });

  it("uses agent maxTurn for the model loop limit", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

    await stream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0].stopWhen).toHaveLength(2);
  });

  it("drops the step-count stop when maxTurn is 0", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        agent: {
          maxTurn: 0,
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
      },
    );

    await stream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0].stopWhen).toHaveLength(1);
  });

  it("exposes skill tools only when skills are enabled", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const loadSkillPrompt = mock(async () => ({
      path: "acct_test/support-flow",
      loadedPaths: ["SKILL.md"],
      bytes: 120,
    }));

    const stream = await runAgentLoop(
      {
        accountId: "acct_test",
        agentId: "agent_test",
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadSkillPrompt: loadSkillPrompt,
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

    await stream.consumeStream();

    const tools = streamTextMock.mock.calls[0]?.[0].tools as Record<
      string,
      {
        execute(input: unknown): Promise<unknown>;
        needsApproval?: boolean;
      }
    >;
    expect(tools.load_skill).toBeDefined();
    const loadSkillTool = tools.load_skill!;
    await expect(
      loadSkillTool.execute({
        path: "acct_test/support-flow",
        resources: [],
      }),
    ).resolves.toBe(
      "Loaded skill acct_test/support-flow: SKILL.md. No sandbox staging path is available for bundled helper files in this turn.",
    );
    expect(loadSkillPrompt).toHaveBeenCalledWith(
      ["acct_test/support-flow"],
      "acct_test/support-flow",
      [],
    );
  });

  it("does not expose load_skill when no skills are configured", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

    await stream.consumeStream();

    expect(streamTextMock.mock.calls[0]?.[0]).not.toHaveProperty("tools");
  });

  it("forwards turn ephemeral system messages into subagent dispatch", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const dispatchSubagents = mock(async () => ({
      tasks: [
        {
          taskId: "subagent_1",
          agentId: "virtual_subagent_1",
          name: "Virtual subagent",
          conversationKey: "subagent-subagent_1",
          runId: "run_1111111111111111111111111111aaaa",
          statusPath: "/v1/runs/run_1111111111111111111111111111aaaa",
          status: "running" as const,
        },
      ],
    }));
    const ephemeralSystem = [
      { role: "system" as const, content: "Use the request-local style." },
    ];

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => [],
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "delegate this" }],
        system: ephemeralSystem,
        ephemeralSystem: ephemeralSystem,
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
      undefined,
      {
        dispatchSubagents: dispatchSubagents,
      },
    );

    await stream.consumeStream();

    const tools = streamTextMock.mock.calls[0]?.[0].tools as Record<
      string,
      {
        execute(
          input: unknown,
          options: { messages: unknown[] },
        ): Promise<unknown>;
      }
    >;
    expect(tools.run_subagent).toBeDefined();
    await tools.run_subagent!.execute(
      {
        tasks: [{ prompt: "research" }],
      },
      {
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
      },
    );
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
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

    await stream.consumeStream();

    expect(googleModelMock).not.toHaveBeenCalled();
    expect(createOpenAIMock).toHaveBeenCalledWith({
      apiKey: "openai-key",
      project: "project-id",
      fetch: expect.any(Function),
    });
    expect(openAIModelMock).toHaveBeenCalledWith("gpt-5.4");

    // Bun drops a fetch whose socket stays silent for 300s, which failed a
    // throttled provider's step mid-run. Model requests turn that timer off.
    const inits: BunFetchRequestInit[] = [];
    globalThis.fetch = (async (_input, init) => {
      inits.push(init ?? {});

      return new Response("ok");
    }) as typeof fetch;
    const [settings] = createOpenAIMock.mock.calls[0] as [
      { fetch: typeof fetch },
    ];
    await settings.fetch("https://api.openai.com/v1/responses", {
      method: "POST",
    });
    expect(inits[0]?.timeout).toBe(false);
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "openai", modelId: "gpt-5.4" },
    });
  });

  it("creates a custom OpenAI-compatible provider from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: {
          custom: {
            apiKey: "custom-key",
            base_url: "https://llm.example/v1",
            headers: { "X-Tenant": "tenant-1" },
          },
        },
        model: {
          provider: "custom",
          modelId: "gpt-oss-120b",
        },
      },
    );

    await stream.consumeStream();

    expect(createOpenAICompatibleMock).toHaveBeenCalledWith({
      apiKey: "custom-key",
      baseURL: "https://llm.example/v1",
      fetch: expect.any(Function),
      headers: { "X-Tenant": "tenant-1" },
      name: "custom",
      includeUsage: true,
    });
    expect(createOpenAIMock).not.toHaveBeenCalled();
    expect(openAICompatibleModelMock).toHaveBeenCalledWith("gpt-oss-120b");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "custom.chat", modelId: "gpt-oss-120b" },
    });
  });

  it("creates an Anthropic provider from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

    await stream.consumeStream();

    expect(createAnthropicMock).toHaveBeenCalledWith({
      apiKey: "anthropic-key",
      baseURL: "https://api.anthropic.example/v1",
      fetch: expect.any(Function),
    });
    expect(anthropicModelMock).toHaveBeenCalledWith("claude-sonnet-4-5");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
    });
  });

  it("creates a MiniMax provider from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const stream = await runAgentLoop(
      {
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: [{ role: "user", content: "hello" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
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
      },
    );

    await stream.consumeStream();

    expect(createMinimaxMock).toHaveBeenCalledWith({
      apiKey: "minimax-key",
      baseURL: "https://api.minimax.io/anthropic/v1",
      fetch: expect.any(Function),
    });
    expect(minimaxModelMock).toHaveBeenCalledWith("MiniMax-M3");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "minimax", modelId: "MiniMax-M3" },
      temperature: 1,
    });
  });

  it("throws when model provider or provider apiKey is missing", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");
    const session = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      sandboxes: () => [],
      environmentText: () => "<environment>",
      persistModelMessages: async () => {},
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

    expect(runAgentLoop(session, turn, {})).rejects.toThrow(
      "config.model.provider is required",
    );
    expect(
      runAgentLoop(session, turn, {
        model: {
          provider: "openai",
          modelId: "gpt-5.4",
        },
      }),
    ).rejects.toThrow("config.provider.openai is required");
    expect(
      runAgentLoop(session, turn, {
        provider: {
          openai: {},
        },
        model: {
          provider: "openai",
          modelId: "gpt-5.4",
        },
      }),
    ).rejects.toThrow("config.provider.openai.apiKey is required");
  });

  it("creates Bedrock and Vercel providers from agent provider config", async () => {
    installHarnessEnv();
    const { runAgentLoop } = await import("../src/harness/harness.ts");

    const baseSession = {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      sandboxes: () => [],
      environmentText: () => "<environment>",
      persistModelMessages: async () => {},
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

    const bedrockApiKey = crypto.randomUUID();
    const gatewayApiKey = crypto.randomUUID();
    const bedrockStream = await runAgentLoop(baseSession, turn, {
      provider: {
        bedrock: {
          region: "us-east-1",
          apiKey: bedrockApiKey,
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
      apiKey: bedrockApiKey,
      fetch: expect.any(Function),
    });
    expect(bedrockModelMock).toHaveBeenCalledWith("amazon.nova-lite-v1:0");

    streamTextMock.mockClear();

    const gatewayStream = await runAgentLoop(baseSession, turn, {
      provider: {
        vercel: {
          apiKey: gatewayApiKey,
        },
      },
      model: {
        provider: "vercel",
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
      apiKey: gatewayApiKey,
      fetch: expect.any(Function),
    });
    expect(gatewayModelMock).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(streamTextMock.mock.calls[0]?.[0]).toMatchObject({
      model: { provider: "vercel", modelId: "openai/gpt-5.4" },
      providerOptions: {
        openai: {
          reasoningEffort: "low",
        },
      },
    });
  });
});

describe("subagent policy input", () => {
  // A child replies to its parent and has no delivery of its own. Its policy
  // input must still name the parent's place and person, or a deny scoped by
  // role never matches and a guest gets the withheld action done through a child.
  it("refuses a child tool call the parent's role-scoped policy denies", async () => {
    installHarnessEnv();
    setStorageForTests({
      ...usageStorage([]),
      agentPolicies: {
        getById: async () => ({
          accountId: "account_1",
          policyId: "policy_guests",
          name: "guests",
          document: {
            version: 1,
            mode: "enforce",
            rules: [
              {
                id: "deny-guest-read",
                effect: "deny",
                actions: ["workspace.read"],
                conditions: [
                  {
                    attribute: "userRoles",
                    operator: "contains",
                    value: "guest",
                  },
                ],
              },
            ],
          },
          status: "active",
          createdAt: "2026-07-02T00:00:00Z",
          updatedAt: "2026-07-02T00:00:00Z",
        }),
      },
    } as unknown as Storage);
    const policyInputs: Array<{ userRoles?: string[] }> = [];
    // Stands in for the rego on loopback, the way policy-enforce.test.ts does:
    // the deny fires only when the input names a guest.
    const opa = Bun.serve({
      port: 0,
      fetch: async function (request: Request): Promise<Response> {
        const body = (await request.json()) as {
          input: { userRoles?: string[] };
        };
        policyInputs.push(body.input);
        const denied = (body.input.userRoles ?? []).includes("guest");

        return Response.json({
          result: {
            allow: !denied,
            allowed: !denied,
            mode: "enforce",
            reason: denied
              ? "Denied by policy rule deny-guest-read"
              : "Allowed",
            matchedRuleIds: denied ? ["deny-guest-read"] : [],
            auditedRuleIds: [],
          },
        });
      },
    });
    const priorOpaBaseUrl = process.env.OPA_BASE_URL;
    process.env.OPA_BASE_URL = `http://127.0.0.1:${opa.port}`;
    try {
      const { Session } = await import("../src/harness/session.ts");
      const { SubagentCoordinator } =
        await import("../src/harness/subagents.ts");
      const parent = new Session({
        eventId: "event_parent",
        conversationKey: "acct:account_1:agent:agent_parent:slack:C_OPS",
        accountId: "account_1",
        agentId: "agent_parent",
        delivery: {
          kind: "channel",
          channelName: "slack",
          identity: {
            channelId: "C_OPS",
            userId: "U_GUEST",
            userRoles: ["guest"],
          },
          source: {},
        },
      });
      const coordinator = new SubagentCoordinator(
        parent,
        { subagent: { enabled: true } },
        Date.now() + 60_000,
      );
      const internals = coordinator as unknown as {
        createChildTurnContext(): Promise<unknown>;
        runTask(task: unknown): Promise<void>;
      };
      internals.createChildTurnContext = async () => ({
        messages: [{ role: "user", content: "run it" }],
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      });

      // The mocked model says nothing, so the child task fails once the loop is built.
      await expect(
        internals.runTask({
          taskId: "subagent_1",
          eventId: "event_child",
          agentId: "agent_child",
          agentConfig: {
            provider: { google: { apiKey: "google-key" } },
            model: { provider: "google", modelId: "gemini-test" },
            policies: ["policy_guests"],
          },
          publicConversationKey: "subagent-subagent_1",
          conversationKey: "acct:account_1:agent:agent_child:api:subagent-1",
          prompt: "run it",
          inheritedContext: false,
          parentMessages: [],
          parentEphemeralSystem: [],
          persistent: false,
          resuming: false,
        }),
      ).rejects.toThrow("Model returned empty response");

      const toolApproval = streamTextMock.mock.calls.at(-1)?.[0]
        .toolApproval as (event: unknown) => Promise<{ type?: string }>;
      const status = await toolApproval({
        toolCall: {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "read",
          input: { path: "secrets/key.pem" },
        },
        messages: [],
      });

      expect(status.type).toBe("denied");
      expect(policyInputs.at(-1)).toMatchObject({
        delivery: "channel",
        channel: "slack",
        channelId: "C_OPS",
        userId: "U_GUEST",
        userRoles: ["guest"],
      });
    } finally {
      opa.stop(true);
      if (priorOpaBaseUrl === undefined) delete process.env.OPA_BASE_URL;
      else process.env.OPA_BASE_URL = priorOpaBaseUrl;
    }
  });
});

function usageStorage(writes: TaskUsageInput[]): Storage {
  return {
    accounts: null as never,
    agents: null as never,
    budgets: null as never,
    agentDeployments: null as never,
    channelRecords: null as never,
    crons: null as never,
    sandboxConfigs: null as never,
    workspaceConfigs: null as never,
    agentPolicies: null as never,
    accountHooks: null as never,
    machineConnections: null as never,
    mcp: null as never,
    roleSessions: null as never,
    taskUsage: {
      record: async function (input) {
        writes.push(input);
      },
    },
  };
}

function installHarnessEnv(): void {
  process.env.MAX_AGENT_ITERATIONS = "3";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
}

// Starts the "real-two-step" weather turn on the real SDK loop.
async function startTwoStepTurn(
  persistModelMessages: () => Promise<string[]> = async () => [],
): Promise<AgentLoopStream> {
  installHarnessEnv();
  streamTextScenario = "real-two-step";
  const { runAgentLoop } = await import("../src/harness/harness.ts");

  return runAgentLoop(
    {
      conversationKey: "direct:conversation",
      eventId: "direct-event",
      filesystemNamespace: () => "fs-test",
      resolvedWorkspaces: () => [],
      sandboxes: () => [],
      environmentText: () => "<environment>",
      persistModelMessages: persistModelMessages,
      renewConversationLease: async () => "renewed",
      applySteeringIngress: async () => null,
      loadRefreshedSystemPromptParts: async () => ({
        systemContextSnapshot: { cursor: null, messages: [] },
        system: [],
      }),
    } as never,
    {
      messages: [{ role: "user", content: "weather in Hanoi?" }],
      system: [],
      ephemeralSystem: [],
      systemContextSnapshot: { cursor: null, messages: [] },
    },
    {
      provider: { google: { apiKey: "google-key" } },
      model: { provider: "google", modelId: "gemini-test" },
    },
    { onFinalText: async () => {}, onErrorText: async () => {} },
  );
}

// Step 0 answers with text and a weather tool call, step 1 with text only.
function twoStepModel(): MockLanguageModelV4 {
  const usage = {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
  const step0 = actualAi.simulateReadableStream<LanguageModelV4StreamPart>({
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "checking" },
      { type: "text-end", id: "t0" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "weather",
        input: JSON.stringify({ city: "Hanoi" }),
      },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_use" },
        usage: usage,
      },
    ],
  });
  const step1 = actualAi.simulateReadableStream<LanguageModelV4StreamPart>({
    // A reader that stops during step 0 must find the model still running.
    initialDelayInMs: 20,
    chunks: [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "31C in Hanoi" },
      { type: "text-end", id: "t1" },
      {
        type: "finish",
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage,
      },
    ],
  });

  return new MockLanguageModelV4({
    doStream: [{ stream: step0 }, { stream: step1 }],
  });
}

describe("system prompt trace attributes", () => {
  it("records the joined instructions the provider is given, with real sizes", async () => {
    const { systemTraceAttributes } = await import("../src/harness/harness.ts");
    const system: SystemModelMessage[] = [
      { role: "system", content: "You are a helpful agent." },
      { role: "system", content: "<skills>\nload_skill first.\n</skills>" },
    ];

    // Traces must show every injected block, not just the agent's own prompt.
    // The joined text is exactly what the provider receives as instructions.
    expect(systemTraceAttributes(system, (value) => String(value))).toEqual({
      "model.system":
        "You are a helpful agent.\n\n<skills>\nload_skill first.\n</skills>",
      "model.system_part_count": 2,
      "model.system_chars": 60,
    });
  });

  it("reports the pre-truncation size so a capped payload is not read as small", async () => {
    const { systemTraceAttributes } = await import("../src/harness/harness.ts");
    const system: SystemModelMessage[] = [
      { role: "system", content: "x".repeat(100) },
    ];
    const attributes = systemTraceAttributes(system, (value) =>
      String(value).slice(0, 10),
    );

    expect(attributes["model.system"]).toBe("x".repeat(10));
    expect(attributes["model.system_chars"]).toBe(100);
  });
});

describe("task input trace attribute", () => {
  it("labels a run with its newest user message text, without media", async () => {
    const { latestUserText } = await import("../src/harness/harness.ts");
    const messages: ModelMessage[] = [
      { role: "user", content: "keep an eye on staging" },
      { role: "assistant", content: "Will do." },
      {
        role: "user",
        content: [
          { type: "text", text: "why did the deploy fail? " },
          { type: "image", image: new URL("https://example.com/log.png") },
          { type: "text", text: "post it in #eng\n" },
        ],
      },
      { role: "assistant", content: "Checking the logs." },
      { role: "tool", content: [] },
    ];

    expect(latestUserText(messages)).toBe(
      "why did the deploy fail? post it in #eng",
    );
    expect(latestUserText([{ role: "assistant", content: "hi" }])).toBe("");
  });
});

describe("tool.call span duration", () => {
  it("reports what the SDK timed, not how late the handler was scheduled", async () => {
    // On parallel calls that scheduling gap is model time, which turned 4ms
    // isolate calls into multi-second spans in the trace.
    const { toolSpanDurationMs } = await import("../src/harness/harness.ts");

    expect(toolSpanDurationMs(1_000, 6_000, 12)).toBe(12);
    expect(toolSpanDurationMs(1_000, 6_000, 0)).toBe(0);
    // No SDK measurement: the handler clock is all there is.
    expect(toolSpanDurationMs(1_000, 6_000, undefined)).toBe(5_000);
    expect(toolSpanDurationMs(1_000, 6_000, Number.NaN)).toBe(5_000);
    // A clock that went backwards must not publish a negative span, whether the
    // negative comes from the handler's own clock or from the SDK's measurement.
    expect(toolSpanDurationMs(6_000, 1_000, undefined)).toBe(0);
    expect(toolSpanDurationMs(1_000, 6_000, -12)).toBe(0);
  });
});

// The lifecycle webhook opens a pinned socket, so the test resolves the hook's
// name to the loopback address its own TLS server listens on. Only loopback is
// exempted; every other address still meets the real denylist.
function hookTransport(): PinnedFetchTransport {
  return {
    allowAddresses: ["127.0.0.1"],
    ca: TLS_CERT,
    lookup: async (): Promise<{ address: string; family: number }[]> => [
      { address: "127.0.0.1", family: 4 },
    ],
  };
}

interface HookDelivery {
  body: string;
  contentType: string | undefined;
  path: string;
  signature: string | undefined;
}

async function startHookServer(
  delivered: HookDelivery[],
): Promise<{ port: number; server: Server }> {
  const server = createHttpsServer(
    { cert: TLS_CERT, key: TLS_KEY },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        delivered.push({
          body: Buffer.concat(chunks).toString("utf8"),
          contentType: request.headers["content-type"],
          path: request.url ?? "",
          signature: request.headers["x-webhook-signature"] as
            | string
            | undefined,
        });
        response.writeHead(200);
        response.end();
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("hook server has no port");
  }

  return { port: address.port, server: server };
}
