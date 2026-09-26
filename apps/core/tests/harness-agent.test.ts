import { beforeEach, expect, it, mock } from "bun:test";

const streamCalls: Record<string, unknown>[] = [];
const steeredTexts: string[] = [];

mock.module("../src/harness/ai-sdk-harness/index.ts", () => ({
  createConfiguredHarnessAgent: () => ({
    agent: {
      stream: async (options: Record<string, unknown>): Promise<never> => {
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
      steeredTexts.push(text);
    },
  }),
  parkAiSdkHarnessSession: async () => {},
}));

beforeEach((): void => {
  streamCalls.length = 0;
  steeredTexts.length = 0;
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
  const onStepStart = streamCalls[0]?.onStepStart as (
    event: unknown,
  ) => Promise<void>;
  await onStepStart({ stepNumber: 1, messages: [] });

  expect(steeredTexts).toEqual(["focus on the tests"]);
  expect(appended).toEqual([[{ role: "user", content: "focus on the tests" }]]);
});

it("leaves steering queued for the next turn on an adapter that cannot take it", async () => {
  const applySteeringIngress = mock(async () => null);
  await runHarnessTurn("codex", applySteeringIngress);
  const callsBeforeTurn = applySteeringIngress.mock.calls.length;

  const onStepStart = streamCalls[0]?.onStepStart as (
    event: unknown,
  ) => Promise<void>;
  await onStepStart({ stepNumber: 1, messages: [] });

  expect(applySteeringIngress).toHaveBeenCalledTimes(callsBeforeTurn);
  expect(steeredTexts).toEqual([]);
});

async function runHarnessTurn(
  type: "claude-code" | "codex",
  applySteeringIngress: () => Promise<unknown>,
  appended: unknown[] = [],
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
        appendIngressEvents: async (events: unknown): Promise<[]> => {
          appended.push(events);

          return [];
        },
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
