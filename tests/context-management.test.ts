/**
 * Session context management tests.
 * Cover pruning defaults and compaction threshold behavior.
 */

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";

const ORIGINAL_ENV = { ...process.env };
const googleModelMock = mock((modelId: string) => ({ provider: "google", modelId }));
const createGoogleMock = mock((_options: unknown) => googleModelMock);
const generateTextMock = mock(async (_options: unknown) => ({ text: "Earlier context summary." }));
const getAgentMock = mock(async (_accountId: string, agentId: string) => ({
  accountId: "acct",
  agentId,
  name: "Research assistant",
  description: "Specialized research agent",
  status: "active" as const,
  config: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

mock.module("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: createGoogleMock,
}));

mock.module("ai", () => ({
  ...actualAi,
  generateText: generateTextMock,
}));

const { setStorageForTests } = await import("../functions/_shared/storage/index.ts");
setStorageForTests({ kind: "dynamodb", agents: { getById: getAgentMock } } as never);

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  generateTextMock.mockClear();
  googleModelMock.mockClear();
  createGoogleMock.mockClear();
  getAgentMock.mockClear();
  setStorageForTests({ kind: "dynamodb", agents: { getById: getAgentMock } } as never);
});

afterAll(() => {
  setStorageForTests(null);
});

describe("session environment context", () => {
  it("adds current time and timezone without a knowledge cutoff", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { Session } = await import("../functions/harness-processing/session.ts");
    const session = new Session("event", "conversation", "acct", "agent", {
      agent: {
        system: "Agent-specific prompt.",
      },
    });

    const turnContext = await session.createEphemeralTurnContext([{ role: "user", content: "hello" }]);
    const environmentPrompt = turnContext.system[0]?.content;

    expect(environmentPrompt).toContain("Current time:");
    expect(environmentPrompt).toContain("Current timezone:");
    expect(environmentPrompt).not.toContain("Knowledge cutoff");
    expect(turnContext.system[1]).toEqual({
      role: "system",
      content: "Agent-specific prompt.",
    });
  });

  it("tells the model to use matching predefined subagent ids", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { Session } = await import("../functions/harness-processing/session.ts");
    const session = new Session("event", "conversation", "acct", "agent", {
      subagent: {
        enabled: true,
        allowed: ["agent_research"],
      },
    });

    const turnContext = await session.createEphemeralTurnContext([{ role: "user", content: "research" }]);
    const subagentPrompt = turnContext.system.find((message) => message.content.includes("<subagent_system>"))?.content;

    expect(subagentPrompt).toContain("- agent_research (Research assistant): Specialized research agent");
    expect(subagentPrompt).toContain("Use the exact agentId from the predefined list when a listed subagent is suitable");
    expect(subagentPrompt).toContain("Omit agentId only when no predefined subagent is suitable");
  });

});

describe("session pruning", () => {
  it("keeps non-reasoning messages unchanged when pruning is disabled", async () => {
    const { pruneSessionMessages } = await import("../functions/harness-processing/pruning.ts");
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as actualAi.ModelMessage[];

    expect(pruneSessionMessages(messages, { session: { pruning: { enabled: false } } })).toEqual(messages);
  });

  it("strips completed assistant reasoning even when pruning is disabled", async () => {
    const { pruneSessionMessages } = await import("../functions/harness-processing/pruning.ts");
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "private scratch work" },
          { type: "text", text: "visible answer" },
        ],
      },
    ] as actualAi.ModelMessage[];

    expect(pruneSessionMessages(messages, { session: { pruning: { enabled: false } } })).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible answer" }],
      },
    ]);
  });

  it("keeps approval tool calls when the latest message is an approval response", async () => {
    const { pruneSessionMessages } = await import("../functions/harness-processing/pruning.ts");
    const messages = [
      { role: "user", content: "delete a file" },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "approval resume reasoning",
          },
          {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "filesystem",
            input: { shell: "rm file.txt" },
          },
          {
            type: "tool-approval-request",
            approvalId: "approval-1",
            toolCallId: "tool-call-1",
          },
        ],
      },
      {
        role: "tool",
        content: [{
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved: true,
        }],
      },
    ] as actualAi.ModelMessage[];

    expect(pruneSessionMessages(messages, {})).toEqual(messages);
  });
});

describe("session compaction", () => {
  const compactingAgentConfig = {
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
      agentConfig: {},
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
      agentConfig: compactingAgentConfig,
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
      agentConfig: compactingAgentConfig,
    });

    const options = generateTextMock.mock.calls[0]?.[0] as { messages: Array<{ content: string }> } | undefined;
    const compactionPrompt = options?.messages[0]?.content;
    expect(compactionPrompt).toContain("Earlier summary.");
    expect(compactionPrompt).toContain("new assistant content");
    expect(compactionPrompt).not.toContain("current request");
  });

  it("strips reasoning before building compaction prompts", async () => {
    const { compactSessionContext } = await import("../functions/harness-processing/compaction.ts");

    await compactSessionContext({
      conversationKey: "conversation",
      system: [],
      messages: [
        { role: "user", content: "old request" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "private scratch work" },
            { type: "text", text: "visible assistant answer" },
          ],
        },
        { role: "user", content: "current request" },
      ],
      agentConfig: compactingAgentConfig,
    });

    const options = generateTextMock.mock.calls[0]?.[0] as { messages: Array<{ content: string }> } | undefined;
    const compactionPrompt = options?.messages[0]?.content;
    expect(compactionPrompt).not.toContain("private scratch work");
    expect(compactionPrompt).toContain("visible assistant answer");
  });

  it("keeps approval requests with approval responses after compaction", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { selectPostCompactionPendingMessages } = await import("../functions/harness-processing/session.ts");
    const approvalRequest = {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "tool-call-1",
          toolName: "filesystem",
          input: { shell: "rm file.txt" },
        },
        {
          type: "tool-approval-request",
          approvalId: "approval-1",
          toolCallId: "tool-call-1",
        },
      ],
    } as actualAi.ModelMessage;
    const approvalResponse = {
      role: "tool",
      content: [{
        type: "tool-approval-response",
        approvalId: "approval-1",
        approved: true,
      }],
    } as actualAi.ModelMessage;

    expect(selectPostCompactionPendingMessages([
      { role: "user", content: "old request" },
      approvalRequest,
      approvalResponse,
    ])).toEqual([approvalRequest, approvalResponse]);
  });

  it("does not compact pending approval resumes", async () => {
    const { compactSessionContext } = await import("../functions/harness-processing/compaction.ts");

    const result = await compactSessionContext({
      conversationKey: "conversation",
      system: [],
      messages: [
        { role: "user", content: "delete a file" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "approval resume reasoning" },
            {
              type: "tool-approval-request",
              approvalId: "approval-1",
              toolCallId: "tool-call-1",
            },
          ],
        },
        {
          role: "tool",
          content: [{
            type: "tool-approval-response",
            approvalId: "approval-1",
            approved: true,
          }],
        },
      ] as actualAi.ModelMessage[],
      agentConfig: compactingAgentConfig,
    });

    expect(result).toBeNull();
  });
});
