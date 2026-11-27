import { describe, expect, mock, test } from "bun:test";

const CORE_ROOT = `${import.meta.dir}/../../../../apps/core/src`;
const AI_PATH = Bun.resolveSync("ai", CORE_ROOT);
const GOOGLE_PATH = Bun.resolveSync("@ai-sdk/google", CORE_ROOT);
const realAi = (await import(AI_PATH)) as typeof import("ai");

const TOO_LONG = "prompt is too long: 210000 tokens > 200000 maximum";
let limit = 1_300;
const prompts: number[] = [];

await mock.module(AI_PATH, (): object => ({
  ...realAi,
  generateText: async (options: {
    messages: Array<{ content: string }>;
  }): Promise<{ text: string; usage: object }> => {
    const length = options.messages[0]?.content.length ?? 0;
    prompts.push(length);
    if (length > limit) throw new Error(TOO_LONG);

    return { text: "summary", usage: {} };
  },
}));
await mock.module(GOOGLE_PATH, (): object => ({
  createGoogle: (): ((modelId: string) => object) => (): object => ({
    modelId: "gemini-test",
    provider: "google",
  }),
  createGoogleGenerativeAI:
    (): ((modelId: string) => object) => (): object => ({
      modelId: "gemini-test",
      provider: "google",
    }),
}));

const { summarizeConversation, CompactionError } =
  await import("../../../../apps/core/src/harness/compaction.ts");

const agentConfig = {
  provider: { google: { apiKey: "google-key" } },
  model: { provider: "google" as const, modelId: "gemini-test" },
};

describe("summarizeBlocks", (): void => {
  test("halves a lone oversized message until the model takes it", async (): Promise<void> => {
    prompts.length = 0;
    const result = await summarizeConversation({
      conversationKey: "conversation",
      priorSummaries: [],
      messages: [{ role: "user", content: "x".repeat(4_000) }],
      agentConfig: agentConfig,
    });

    expect(result?.modelCalls).toBe(1);
    expect(prompts.filter((length): boolean => length > limit)).toHaveLength(2);
    expect(prompts.at(-1)).toBeLessThanOrEqual(limit);
  });

  test("fails a refused message too short to split", async (): Promise<void> => {
    limit = 10;
    const attempt = summarizeConversation({
      conversationKey: "conversation",
      priorSummaries: [],
      messages: [{ role: "user", content: "short" }],
      agentConfig: agentConfig,
    });

    await expect(attempt).rejects.toBeInstanceOf(CompactionError);
    await expect(attempt).rejects.toThrow("prompt is too long");
    limit = 1_300;
  });
});
