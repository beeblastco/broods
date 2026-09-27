import { afterAll, beforeEach, expect, it, mock } from "bun:test";
import * as harnessIndex from "../src/harness/ai-sdk-harness/index.ts";

// The part of the harness stream options these tests read.
interface HarnessStreamCall {
  abortSignal?: AbortSignal;
  onEnd?: unknown;
  onStepStart?: (event: { stepNumber: number }) => Promise<void>;
  [hook: string]: unknown;
}

// Copied before the mock below rewrites the module, so afterAll can put it back.
const realHarnessIndex = { ...harnessIndex };
const streamCalls: HarnessStreamCall[] = [];
const steeredTexts: string[] = [];
let steerFailure: Error | null = null;

mock.module("../src/harness/ai-sdk-harness/index.ts", () => ({
  createConfiguredHarnessAgent: () => ({
    agent: {
      stream: async (options: HarnessStreamCall): Promise<never> => {
        streamCalls.push(options);
        throw new Error("stop after the stream call");
      },
    },
  }),
  harnessReservationKey: (options: { conversationKey: string }): string =>
    options.conversationKey,
  harnessSteersMidTurn: (type: string): boolean => type !== "codex",
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
afterAll((): void => {
  mock.module(
    "../src/harness/ai-sdk-harness/index.ts",
    (): typeof harnessIndex => realHarnessIndex,
  );
});

beforeEach((): void => {
  streamCalls.length = 0;
  steeredTexts.length = 0;
  steerFailure = null;
});

it("hands a harness agent the same step and tool hooks as streamText", async () => {
  await runHarnessTurn("codex", async () => null);

  expect(streamCalls).toHaveLength(1);
  for (const hook of [
    "onStepStart",
    "onStepEnd",
    "onToolExecutionStart",
    "onToolExecutionEnd",
  ]) {
    expect(typeof streamCalls[0]?.[hook]).toBe("function");
  }
  expect(streamCalls[0]?.onEnd).toBeUndefined();
});

it("steers a running harness turn at its next step", async () => {
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
  await runHarnessTurn("claude-code", applySteeringIngress, appended);

  queued = true;
  await streamCalls[0]?.onStepStart?.({ stepNumber: 1 });

  expect(applySteeringIngress).toHaveBeenLastCalledWith({ textOnly: true });
  expect(steeredTexts).toEqual(["focus on the tests"]);
  expect(appended).toEqual([[{ role: "user", content: "focus on the tests" }]]);
});

it("leaves steering queued for the next turn on an adapter that cannot take it", async () => {
  const applySteeringIngress = mock(async () => null);
  await runHarnessTurn("codex", applySteeringIngress);
  const callsBeforeTurn = applySteeringIngress.mock.calls.length;

  await streamCalls[0]?.onStepStart?.({ stepNumber: 1 });

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
    [],
    async (): Promise<never> => {
      throw new Error("convex down");
    },
  );

  queued = true;
  await streamCalls[0]?.onStepStart?.({ stepNumber: 1 });

  expect(streamCalls[0]?.abortSignal?.aborted).toBe(true);
  expect(steeredTexts).toEqual(["focus"]);
});

it("fails the run instead of saving a steer the turn did not take", async () => {
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
    appended,
  );

  queued = true;
  steerFailure = new Error("no running turn to steer");
  await streamCalls[0]?.onStepStart?.({ stepNumber: 1 });

  expect(streamCalls[0]?.abortSignal?.aborted).toBe(true);
  expect(appended).toEqual([]);
});

async function runHarnessTurn(
  type: "claude-code" | "codex",
  applySteeringIngress: () => Promise<unknown>,
  appended: unknown[] = [],
  appendIngressEvents: (events: unknown) => Promise<[]> = async (
    events,
  ): Promise<[]> => {
    appended.push(events);

    return [];
  },
): Promise<void> {
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  const { runAgentLoop } = await import("../src/harness/harness.ts");

  await expect(
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
        messages: [{ role: "user", content: "hello" }],
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
