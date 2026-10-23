import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import type { ModelMessage } from "ai";
import {
  harnessSteersMidTurn,
  type AiSdkHarnessType,
} from "../src/harness/ai-sdk-harness/adapters/index.ts";
import * as harnessIndex from "../src/harness/ai-sdk-harness/index.ts";

// The part of the harness stream options these tests read.
interface HarnessStreamCall {
  abortSignal?: AbortSignal;
  messages?: ModelMessage[];
  onEnd?: unknown;
  onStepStart?: (event: {
    stepNumber: number;
    messages: ModelMessage[];
  }) => Promise<void>;
  [hook: string]: unknown;
}

// What a test may change about the turn runHarnessTurn starts.
interface HarnessTurnOptions {
  appended?: unknown[];
  appendIngressEvents?: (events: unknown) => Promise<[]>;
  messages?: ModelMessage[];
}

// Copied before the mock below rewrites the module, so afterAll can put it back.
const realHarnessIndex = { ...harnessIndex };
const streamCalls: HarnessStreamCall[] = [];
const steeredTexts: string[] = [];
let steerFailure: Error | null = null;

await mock.module("../src/harness/ai-sdk-harness/index.ts", () => ({
  createConfiguredHarnessAgent: () => ({
    agent: {
      stream: async (options: HarnessStreamCall): Promise<never> => {
        streamCalls.push(options);
        throw new Error("stop after the stream call");
      },
    },
  }),
  harnessSteersMidTurn: harnessSteersMidTurn,
  openAiSdkHarnessSession: async () => ({
    destroy: async (): Promise<void> => {},
    experimental_steerTurn: async (text: string): Promise<void> => {
      if (steerFailure) throw steerFailure;
      steeredTexts.push(text);
    },
  }),
  parkAiSdkHarnessSession: async () => {},
}));

// mock.module is process-wide; restore the real harness for later test files.
afterAll(async (): Promise<void> => {
  await mock.module(
    "../src/harness/ai-sdk-harness/index.ts",
    (): typeof harnessIndex => realHarnessIndex,
  );
});

beforeEach((): void => {
  streamCalls.length = 0;
  steeredTexts.length = 0;
  steerFailure = null;
});

it.each(["claude-code", "codex"] as const)(
  "steers a running %s turn at its next step",
  async (type) => {
    let queued = false;
    const appended: unknown[] = [];
    const applySteeringIngress = mock(async () => {
      if (!queued) return null;
      queued = false;

      return {
        events: [{ role: "user", content: "focus on the tests" }],
        contributingEventIds: ["steer-1"],
        appliedMode: "steer",
      };
    });
    await runHarnessTurn(type, applySteeringIngress, { appended: appended });

    queued = true;
    await streamCalls[0]?.onStepStart?.({ stepNumber: 1, messages: [] });

    expect(applySteeringIngress).toHaveBeenLastCalledWith({ textOnly: true });
    expect(steeredTexts).toEqual(["focus on the tests"]);
    expect(appended).toEqual([
      [{ role: "user", content: "focus on the tests" }],
    ]);
  },
);

it("leaves steering queued for the next turn on an adapter that cannot take it", async () => {
  const applySteeringIngress = mock(async () => null);
  await runHarnessTurn("deepagents", applySteeringIngress);
  const callsBeforeTurn = applySteeringIngress.mock.calls.length;

  await streamCalls[0]?.onStepStart?.({ stepNumber: 1, messages: [] });

  expect(applySteeringIngress).toHaveBeenCalledTimes(callsBeforeTurn);
  expect(steeredTexts).toEqual([]);
});

it("fails the run when a claimed steer cannot be saved", async () => {
  let queued = false;
  await runHarnessTurn(
    "claude-code",
    async () =>
      queued
        ? {
            events: [{ role: "user", content: "focus" }],
            contributingEventIds: ["steer-1"],
            appliedMode: "steer",
          }
        : null,
    {
      appendIngressEvents: async (): Promise<never> => {
        throw new Error("convex down");
      },
    },
  );

  queued = true;
  await streamCalls[0]?.onStepStart?.({ stepNumber: 1, messages: [] });

  expect(streamCalls[0]?.abortSignal?.aborted).toBe(true);
  expect(steeredTexts).toEqual([]);
});

it("fails the run but keeps a steer the turn did not take", async () => {
  let queued = false;
  const appended: unknown[] = [];
  await runHarnessTurn(
    "claude-code",
    async () =>
      queued
        ? {
            events: [{ role: "user", content: "focus" }],
            contributingEventIds: ["steer-1"],
            appliedMode: "steer",
          }
        : null,
    { appended: appended },
  );

  queued = true;
  steerFailure = new Error("no running turn to steer");
  await streamCalls[0]?.onStepStart?.({ stepNumber: 1, messages: [] });

  expect(streamCalls[0]?.abortSignal?.aborted).toBe(true);
  expect(appended).toEqual([[{ role: "user", content: "focus" }]]);
});

it("hands a harness a picture natively, after the text, and other files as a note", async () => {
  await runHarnessTurn("pi", async () => null, {
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: new Uint8Array([1]), mediaType: "image/png" },
          { type: "text", text: "what is this?" },
          {
            type: "file",
            data: new Uint8Array([2]),
            mediaType: "application/pdf",
            filename: "brief.pdf",
          },
        ],
      },
    ],
  });

  const content = streamCalls[0]?.messages?.at(-1)?.content;
  expect(Array.isArray(content) && content.map((part) => part.type)).toEqual([
    "text",
    "text",
    "text",
    "image",
  ]);
  expect(JSON.stringify(content)).toContain(
    "[brief.pdf (application/pdf) was not shown to you",
  );
});

async function runHarnessTurn(
  type: AiSdkHarnessType,
  applySteeringIngress: () => Promise<unknown>,
  options: HarnessTurnOptions = {},
): Promise<void> {
  const appended = options.appended ?? [];
  const appendIngressEvents =
    options.appendIngressEvents ??
    (async (events: unknown): Promise<[]> => {
      appended.push(events);

      return [];
    });
  const messages = options.messages ?? [{ role: "user", content: "hello" }];
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  const { runAgentLoop } = await import("../src/harness/harness.ts");

  expect(
    runAgentLoop(
      {
        accountId: "acct_test",
        agentId: "agent_test",
        conversationKey: "direct:conversation",
        eventId: "direct-event",
        filesystemNamespace: () => "fs-test",
        resolvedWorkspaces: () => [],
        sandboxes: () => [{ sandbox: { provider: "lambda" } }],
        environmentText: () => "<environment>",
        persistModelMessages: async () => {},
        flushPendingStoredEvents: async () => {},
        applySteeringIngress: applySteeringIngress,
        appendIngressEvents: appendIngressEvents,
        loadHarnessSession: async () => null,
        loadHarnessSkills: async () => [],
        renewConversationLease: async () => ({ renewed: true }),
        loadRefreshedSystemPromptParts: async () => ({
          systemContextSnapshot: { cursor: null, messages: [] },
          system: [],
        }),
      } as never,
      {
        messages: messages,
        system: [],
        ephemeralSystem: [],
        systemContextSnapshot: { cursor: null, messages: [] },
      },
      {
        provider: { openai: { apiKey: "openai-key" } },
        model: { provider: "openai", modelId: "gpt-test" },
        harness: { type: type },
      },
    ),
  ).rejects.toThrow("stop after the stream call");
}
