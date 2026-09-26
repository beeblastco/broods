import { expect, it, mock } from "bun:test";

const streamCalls: Record<string, unknown>[] = [];

mock.module("../src/harness/ai-sdk-harness/index.ts", () => ({
  createConfiguredHarnessAgent: () => ({
    agent: {
      stream: async (options: Record<string, unknown>): Promise<never> => {
        streamCalls.push(options);
        throw new Error("stop after the stream call");
      },
    },
  }),
  openAiSdkHarnessSession: async () => ({ destroy: async () => {} }),
  parkAiSdkHarnessSession: async () => {},
}));

it("hands a harness agent the same step and tool hooks as streamText", async () => {
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
        applySteeringIngress: async () => null,
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
        harness: { type: "codex" },
      },
    ),
  ).rejects.toThrow("stop after the stream call");

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
