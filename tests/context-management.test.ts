/**
 * Session context management tests.
 * Cover pruning defaults and compaction threshold behavior.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";

const googleModelMock = mock((modelId: string) => ({ provider: "google", modelId }));
const createGoogleMock = mock((_options: unknown) => googleModelMock);
const generateTextMock = mock(async (_options: unknown) => ({ text: "Earlier context summary." }));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: createGoogleMock,
}));

mock.module("ai", () => ({
  ...actualAi,
  generateText: generateTextMock,
}));

afterEach(() => {
  generateTextMock.mockClear();
  googleModelMock.mockClear();
  createGoogleMock.mockClear();
});

describe("session pruning", () => {
  it("returns original messages when pruning is disabled", async () => {
    const { pruneSessionMessages } = await import("../functions/harness-processing/pruning.ts");
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as actualAi.ModelMessage[];

    expect(pruneSessionMessages(messages, { session: { pruning: { enabled: false } } })).toBe(messages);
  });
});

describe("session compaction", () => {
  const compactingAccountConfig = {
    provider: {
      google: {
        apiKey: "google-key",
      },
    },
    model: {
      provider: "google" as const,
      modelId: "gemini-test",
    },
    session: {
      compaction: {
        enabled: true,
        maxContextLength: 1,
      },
    },
  };

  it("does not compact when disabled", async () => {
    const { compactSessionContext } = await import("../functions/harness-processing/compaction.ts");

    const result = await compactSessionContext({
      conversationKey: "conversation",
      system: [],
      messages: [{ role: "user", content: "hello" }],
      accountConfig: {},
    });

    expect(result).toBeNull();
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("uses the configured model when enabled context exceeds the limit", async () => {
    const { compactSessionContext, isCompactionSummaryMessage } = await import("../functions/harness-processing/compaction.ts");

    const result = await compactSessionContext({
      conversationKey: "conversation",
      system: [{ role: "system", content: "system" }],
      messages: [
        { role: "user", content: "old user content that should be summarized" },
        { role: "assistant", content: "old assistant content that should be summarized" },
        { role: "user", content: "current request" },
      ],
      accountConfig: compactingAccountConfig,
    });

    expect(result).toBeDefined();
    expect(isCompactionSummaryMessage(result!)).toBe(true);
    expect(createGoogleMock).toHaveBeenCalledWith({ apiKey: "google-key" });
    expect(googleModelMock).toHaveBeenCalledWith("gemini-test");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("includes previous compaction summaries when compacting again", async () => {
    const { compactSessionContext } = await import("../functions/harness-processing/compaction.ts");
    const priorSummary = {
      role: "system",
      content: "<session-compaction-summary>\nEarlier summary.\n</session-compaction-summary>",
    } as const;

    await compactSessionContext({
      conversationKey: "conversation",
      system: [priorSummary],
      messages: [
        { role: "assistant", content: "new assistant content" },
        { role: "user", content: "current request" },
      ],
      accountConfig: compactingAccountConfig,
    });

    const options = generateTextMock.mock.calls[0]?.[0] as { messages: Array<{ content: string }> } | undefined;
    const compactionPrompt = options?.messages[0]?.content;
    expect(compactionPrompt).toContain("Earlier summary.");
    expect(compactionPrompt).toContain("new assistant content");
    expect(compactionPrompt).not.toContain("current request");
  });
});
