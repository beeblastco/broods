/**
 * Session context management tests.
 * Cover pruning defaults and compaction threshold behavior.
 */

import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";
import * as realS3 from "../src/shared/s3.ts";

const ORIGINAL_ENV = { ...process.env };
const googleModelMock = mock((modelId: string) => ({
  provider: "google",
  modelId,
}));
const createGoogleMock = mock((_options: unknown) => googleModelMock);
const generateTextMock = mock(async (_options: unknown) => ({
  text: "Earlier context summary.",
}));
const readS3TextMock = mock(
  async (_bucket: string, _key: string): Promise<string> => {
    const error = new Error("not found") as Error & {
      name: string;
      $metadata: { httpStatusCode: number };
    };
    error.name = "NoSuchKey";
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  },
);
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
  createGoogle: createGoogleMock,
  createGoogleGenerativeAI: createGoogleMock,
}));

mock.module("ai", () => ({
  ...actualAi,
  generateText: generateTextMock,
}));

// Spread the real module first: mock.module is process-global, so any export
// omitted here disappears for every test file that loads after this one.
mock.module("../src/shared/s3.ts", () => ({
  ...realS3,
  isMissingS3Error: (error: unknown) =>
    typeof error === "object" &&
    error !== null &&
    "$metadata" in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 404,
  readS3Text: readS3TextMock,
  readS3Bytes: mock(async () => new Uint8Array()),
  writeS3Object: mock(async () => 0),
  s3ObjectExists: mock(async () => false),
  listS3Prefix: mock(async () => []),
  deleteS3Object: mock(async () => {}),
  deleteS3Prefix: mock(async () => 0),
  copyS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
}));

let workspaceHarnessEnabled = true;
const testStorage = () =>
  ({
    agents: { getById: getAgentMock },
    sandboxConfigs: { getById: async () => null },
    workspaceConfigs: {
      getById: async (_accountId: string, workspaceId: string) => ({
        accountId: "acct",
        workspaceId,
        name: "default",
        config: {
          storage: { provider: "s3" },
          harness: { enabled: workspaceHarnessEnabled },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    },
  }) as never;

const { setStorageForTests } = await import("../src/shared/storage.ts");
setStorageForTests(testStorage());

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  generateTextMock.mockClear();
  googleModelMock.mockClear();
  createGoogleMock.mockClear();
  readS3TextMock.mockImplementation(async () => {
    const error = new Error("not found") as Error & {
      name: string;
      $metadata: { httpStatusCode: number };
    };
    error.name = "NoSuchKey";
    error.$metadata = { httpStatusCode: 404 };
    throw error;
  });
  readS3TextMock.mockClear();
  getAgentMock.mockClear();
  workspaceHarnessEnabled = true;
  setStorageForTests(testStorage());
});

afterAll(() => {
  setStorageForTests(null);
});

describe("session system context", () => {
  it("uses only developer-provided system context", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { Session } = await import("../src/harness/session.ts");
    const session = new Session("event", "conversation", "acct", "agent", {
      agent: {
        system: "Agent-specific prompt.",
      },
    });

    const turnContext = await session.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);

    expect(turnContext.system).toEqual([
      {
        role: "system",
        content: "Agent-specific prompt.",
      },
    ]);
  });

  it("preserves agent-level system message events", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { Session } = await import("../src/harness/session.ts");
    const session = new Session("event", "conversation", "acct", "agent", {
      agent: {
        system: [
          {
            role: "system",
            content: "Use cached policy.",
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" } },
            },
          },
        ],
      },
    });

    const turnContext = await session.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);

    expect(turnContext.system).toEqual([
      {
        role: "system",
        content: "Use cached policy.",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
  });

  it("tells the model to use matching predefined subagent ids", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { Session } = await import("../src/harness/session.ts");
    const session = new Session("event", "conversation", "acct", "agent", {
      subagent: {
        enabled: true,
        allowed: ["agent_research"],
      },
    });

    const turnContext = await session.createEphemeralTurnContext([
      { role: "user", content: "research" },
    ]);
    const subagentPrompt = turnContext.system.find((message) =>
      message.content.includes("<subagent>"),
    )?.content;

    expect(subagentPrompt).toContain(
      "- agent_research (Research assistant): Specialized research agent",
    );
    expect(subagentPrompt).toContain(
      "Use the exact agentId from the predefined list when a listed subagent is suitable",
    );
    expect(subagentPrompt).toContain(
      "Omit agentId only when no predefined subagent is suitable",
    );
  });

  it("loads existing workspace memory separately from optional harness guidance", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    readS3TextMock.mockResolvedValue("Remember stable project facts.");
    const { Session } = await import("../src/harness/session.ts");

    const enabledSession = new Session(
      "event",
      "conversation",
      "acct",
      "agent",
      {
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
      },
    );
    const enabledContext = await enabledSession.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);
    const memoryPrompt = enabledContext.system.find((message) =>
      message.content.includes("Current memory index"),
    )?.content;
    const workspacePrompt = enabledContext.system.find((message) =>
      message.content.includes("<workspace>"),
    )?.content;
    expect(memoryPrompt).toContain("Remember stable project facts.");
    // No sandbox in this test mock => read-only workspace: only read/glob are advertised.
    expect(workspacePrompt).toContain("read, glob");
    expect(workspacePrompt).toContain("[read-only");
    expect(workspacePrompt).not.toContain("write");
    // The memory index is loaded as a separate system message, not wired into the workspace guidance.
    expect(workspacePrompt).not.toContain("MEMORY.md");
    // The index lives inside the memory/ folder, not at the workspace root.
    expect(readS3TextMock).toHaveBeenCalledWith(
      "filesystem",
      expect.stringContaining("/memory/MEMORY.md"),
    );
    // Read-only workspace => no memory_save => no <memory> guidance block.
    expect(
      enabledContext.system.some((message) =>
        message.content.startsWith("<memory>"),
      ),
    ).toBe(false);
  });

  it("adds <memory> guidance only when a sandbox-backed workspace exposes memory_save", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { Session } = await import("../src/harness/session.ts");

    const storageWithSandbox = (workspaceConfig: Record<string, unknown>) =>
      ({
        ...(testStorage() as object),
        sandboxConfigs: {
          getById: async (_accountId: string, sandboxId: string) => ({
            accountId: "acct",
            sandboxId,
            name: "lambda",
            config: { provider: "lambda", network: { mode: "deny-all" } },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        },
        workspaceConfigs: {
          getById: async (_accountId: string, workspaceId: string) => ({
            accountId: "acct",
            workspaceId,
            name: "default",
            config: workspaceConfig,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        },
      }) as never;

    // Sandbox-backed workspace: the block names this conversation's scope as originSessionId.
    setStorageForTests(storageWithSandbox({ storage: { provider: "s3" } }));
    const writable = new Session(
      "event",
      "acct:acct_1:agent:agent_1:slack:T1:C2:11.22",
      "acct",
      "agent",
      {
        sandbox: "sb_1",
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
      },
    );
    const writableContext = await writable.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);
    const memoryGuidance = writableContext.system.find((message) =>
      message.content.startsWith("<memory>"),
    )?.content;
    expect(memoryGuidance).toContain(
      'this conversation\'s scope is "slack:T1:C2"',
    );
    expect(memoryGuidance).toContain("memory/MEMORY.md");
    expect(memoryGuidance).toContain("Today is");
    const workspacePrompt = writableContext.system.find((message) =>
      message.content.includes("<workspace>"),
    )?.content;
    expect(workspacePrompt).toContain("memory_save");

    // harness.memory opt-out removes the tool, so the guidance disappears with it.
    setStorageForTests(
      storageWithSandbox({
        storage: { provider: "s3" },
        harness: { memory: { enabled: false } },
      }),
    );
    const optedOut = new Session(
      "event",
      "acct:acct_1:agent:agent_1:slack:T1:C2:11.22",
      "acct",
      "agent",
      {
        sandbox: "sb_1",
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
      },
    );
    const optedOutContext = await optedOut.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);
    expect(
      optedOutContext.system.some((message) =>
        message.content.startsWith("<memory>"),
      ),
    ).toBe(false);
  });

  it("allows disabling workspace harness guidance without disabling MEMORY.md loading", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    readS3TextMock.mockResolvedValue("Keep this in context.");
    workspaceHarnessEnabled = false;
    const { Session } = await import("../src/harness/session.ts");
    const disabledSession = new Session(
      "event",
      "conversation",
      "acct",
      "agent",
      {
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
      },
    );
    const disabledContext = await disabledSession.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);
    expect(
      disabledContext.system.some((message) =>
        message.content.includes("<workspace>"),
      ),
    ).toBe(false);
    expect(
      disabledContext.system.some((message) =>
        message.content.includes("Keep this in context."),
      ),
    ).toBe(true);
  });
});

describe("session pruning", () => {
  it("keeps non-reasoning messages unchanged when pruning is disabled", async () => {
    const { pruneSessionMessages } = await import("../src/harness/pruning.ts");
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ] as actualAi.ModelMessage[];

    expect(
      pruneSessionMessages(messages, {
        session: { pruning: { enabled: false } },
      }),
    ).toEqual(messages);
  });

  it("strips completed assistant reasoning even when pruning is disabled", async () => {
    const { pruneSessionMessages } = await import("../src/harness/pruning.ts");
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

    expect(
      pruneSessionMessages(messages, {
        session: { pruning: { enabled: false } },
      }),
    ).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [{ type: "text", text: "visible answer" }],
      },
    ]);
  });

  it("keeps approval tool calls when the latest message is an approval response", async () => {
    const { pruneSessionMessages } = await import("../src/harness/pruning.ts");
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
      {
        role: "tool",
        content: [
          {
            type: "tool-approval-response",
            approvalId: "approval-1",
            approved: true,
          },
        ],
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
    const { compactSessionContext } =
      await import("../src/harness/compaction.ts");

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
    const { compactSessionContext, isCompactionSummaryMessage } =
      await import("../src/harness/compaction.ts");

    const result = await compactSessionContext({
      conversationKey: "conversation",
      system: [{ role: "system", content: "system" }],
      messages: [
        { role: "user", content: "old user content that should be summarized" },
        {
          role: "assistant",
          content: "old assistant content that should be summarized",
        },
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
    const { compactSessionContext } =
      await import("../src/harness/compaction.ts");
    const priorSummary = {
      role: "system",
      content:
        "<session-compaction-summary>\nEarlier summary.\n</session-compaction-summary>",
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

    const options = generateTextMock.mock.calls[0]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    const compactionPrompt = options?.messages[0]?.content;
    expect(compactionPrompt).toContain("Earlier summary.");
    expect(compactionPrompt).toContain("new assistant content");
    expect(compactionPrompt).not.toContain("current request");
  });

  it("strips reasoning before building compaction prompts", async () => {
    const { compactSessionContext } =
      await import("../src/harness/compaction.ts");

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

    const options = generateTextMock.mock.calls[0]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    const compactionPrompt = options?.messages[0]?.content;
    expect(compactionPrompt).not.toContain("private scratch work");
    expect(compactionPrompt).toContain("visible assistant answer");
  });

  it("keeps approval requests with approval responses after compaction", async () => {
    process.env.CONVERSATIONS_TABLE_NAME = "conversations";
    process.env.PROCESSED_EVENTS_TABLE_NAME = "processed-events";
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const { selectPostCompactionPendingMessages } =
      await import("../src/harness/session.ts");
    const approvalRequest = {
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
    } as actualAi.ModelMessage;
    const approvalResponse = {
      role: "tool",
      content: [
        {
          type: "tool-approval-response",
          approvalId: "approval-1",
          approved: true,
        },
      ],
    } as actualAi.ModelMessage;

    expect(
      selectPostCompactionPendingMessages([
        { role: "user", content: "old request" },
        approvalRequest,
        approvalResponse,
      ]),
    ).toEqual([approvalRequest, approvalResponse]);
  });

  it("does not compact pending approval resumes", async () => {
    const { compactSessionContext } =
      await import("../src/harness/compaction.ts");

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
          content: [
            {
              type: "tool-approval-response",
              approvalId: "approval-1",
              approved: true,
            },
          ],
        },
      ] as actualAi.ModelMessage[],
      agentConfig: compactingAgentConfig,
    });

    expect(result).toBeNull();
  });
});
