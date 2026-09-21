import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import * as actualAi from "ai";
import type {
  Session,
  StoredConversationEventPage,
} from "../src/harness/session.ts";
import type { AgentConfig } from "../src/shared/domain/agent-config.ts";
import * as realS3 from "../src/shared/s3.ts";

const ORIGINAL_ENV = { ...process.env };
const googleModelMock = mock((modelId: string) => ({
  provider: "google",
  modelId: modelId,
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
  agentId: agentId,
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
        workspaceId: workspaceId,
        name: "default",
        config: {
          storage: { provider: "s3" },
          harness: { workspace: { enabled: workspaceHarnessEnabled } },
        },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    },
  }) as never;

const { setStorageForTests } = await import("../src/shared/storage.ts");

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
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const session = await newSession({
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
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const session = await newSession({
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
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const session = await newSession({
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

  it("gives a scheduling agent one clock reading for the whole run", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const session = await newSession({
      scheduler: { enabled: true },
    });

    const first = await session.createEphemeralTurnContext([
      { role: "user", content: "remind me at 8:45 tonight" },
    ]);
    const second = await session.createEphemeralTurnContext([
      { role: "user", content: "and again tomorrow" },
    ]);
    const schedulerPrompt = first.system.find((message) =>
      message.content.includes("<scheduler>"),
    )?.content;

    expect(schedulerPrompt).toMatch(
      /The current time is \d{4}-\d{2}-\d{2}T[\d:.]+Z \(UTC\)/,
    );
    expect(schedulerPrompt).toContain(
      "list_schedules is what is actually pending",
    );
    // A timestamp that moved between steps would invalidate the prompt cache.
    expect(
      second.system.find((message) => message.content.includes("<scheduler>"))
        ?.content,
    ).toBe(schedulerPrompt);
  });

  it("withholds the scheduling clock until the agent opts in", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const session = await newSession({});

    const turnContext = await session.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);

    expect(
      turnContext.system.some((message) =>
        message.content.includes("<scheduler>"),
      ),
    ).toBe(false);
  });

  it("loads existing workspace memory separately from optional harness guidance", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    readS3TextMock.mockResolvedValue("Remember stable project facts.");

    const enabledSession = await newSession({
      workspaces: [{ name: "default", workspaceId: "ws_a" }],
    });
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
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";

    const storageWithSandbox = (workspaceConfig: Record<string, unknown>) =>
      ({
        ...(testStorage() as object),
        sandboxConfigs: {
          getById: async (_accountId: string, sandboxId: string) => ({
            accountId: "acct",
            sandboxId: sandboxId,
            name: "lambda",
            config: { provider: "lambda", network: { mode: "deny-all" } },
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        },
        workspaceConfigs: {
          getById: async (_accountId: string, workspaceId: string) => ({
            accountId: "acct",
            workspaceId: workspaceId,
            name: "default",
            config: workspaceConfig,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        },
      }) as never;

    // Sandbox-backed workspace: the block names this conversation's scope as originSessionId.
    setStorageForTests(storageWithSandbox({ storage: { provider: "s3" } }));
    const writable = await newSession(
      {
        sandboxes: ["sb_1"],
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
      },
      "acct:acct_1:agent:agent_1:slack:T1:C2:11.22",
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

    // harness.memory opt-out is total: no tool guidance, no index in context even
    // when the file exists, and the workspace guidance stops recommending memory.
    setStorageForTests(
      storageWithSandbox({
        storage: { provider: "s3" },
        harness: { memory: { enabled: false } },
      }),
    );
    readS3TextMock.mockResolvedValue("MUST NOT REACH THE MODEL");
    const optedOut = await newSession(
      {
        sandboxes: ["sb_1"],
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
      },
      "acct:acct_1:agent:agent_1:slack:T1:C2:11.22",
    );
    const optedOutContext = await optedOut.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);
    expect(
      optedOutContext.system.some((message) =>
        message.content.startsWith("<memory>"),
      ),
    ).toBe(false);
    expect(
      optedOutContext.system.some((message) =>
        message.content.includes("MUST NOT REACH THE MODEL"),
      ),
    ).toBe(false);
    const optedOutWorkspacePrompt = optedOutContext.system.find((message) =>
      message.content.includes("<workspace>"),
    )?.content;
    expect(optedOutWorkspacePrompt).toContain("Structured memory is disabled");
    expect(optedOutWorkspacePrompt).not.toContain("memory_save");
  });

  it("allows disabling workspace harness guidance without disabling MEMORY.md loading", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    readS3TextMock.mockResolvedValue("Keep this in context.");
    workspaceHarnessEnabled = false;
    const disabledSession = await newSession({
      workspaces: [{ name: "default", workspaceId: "ws_a" }],
    });
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

  it("drops the workspace prompt when an AI SDK harness owns the run", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    setStorageForTests({
      ...(testStorage() as object),
      sandboxConfigs: {
        getById: async (_accountId: string, sandboxId: string) => ({
          accountId: "acct",
          sandboxId: sandboxId,
          name: "lambda",
          config: { provider: "lambda", network: { mode: "deny-all" } },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      },
    } as never);
    const harnessSession = await newSession(
      {
        harness: { type: "codex" },
        sandboxes: ["sb_1"],
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
      },
      "acct:acct_1:agent:agent_1:slack:T1:C2:11.22",
    );
    const harnessContext = await harnessSession.createEphemeralTurnContext([
      { role: "user", content: "hello" },
    ]);
    expect(
      harnessContext.system.some((message) =>
        message.content.includes("<workspace>"),
      ),
    ).toBe(false);
    // memory_save collides with no adapter builtin, so its block still applies.
    expect(
      harnessContext.system.some((message) =>
        message.content.startsWith("<memory>"),
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

  it("keeps reasoning on a stored-item provider, whose message replay needs it", async () => {
    const { pruneSessionMessages } = await import("../src/harness/pruning.ts");
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "",
            providerOptions: { openai: { itemId: "rs_1" } },
          },
          {
            type: "text",
            text: "visible answer",
            providerOptions: { openai: { itemId: "msg_1" } },
          },
        ],
      },
    ] as actualAi.ModelMessage[];

    expect(
      pruneSessionMessages(messages, {
        model: { provider: "openai", modelId: "gpt-5.6" },
      }),
    ).toEqual(messages);
  });

  it("keeps an old tool call on a stored-item provider and prunes it elsewhere", async () => {
    const { pruneSessionMessages } = await import("../src/harness/pruning.ts");
    const messages = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { shell: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "bash",
            output: { type: "text", value: "file.txt" },
          },
        ],
      },
      { role: "assistant", content: "one file" },
      { role: "user", content: "thanks" },
    ] as actualAi.ModelMessage[];

    expect(
      pruneSessionMessages(messages, {
        model: { provider: "openai", modelId: "gpt-5.6" },
      }),
    ).toEqual(messages);
    expect(
      pruneSessionMessages(messages, {
        model: { provider: "google", modelId: "gemini-test" },
      }),
    ).toEqual([
      messages[0],
      messages[3],
      messages[4],
    ] as actualAi.ModelMessage[]);
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

describe("stored item persistence", () => {
  const assistantWithReasoning: actualAi.AssistantModelMessage = {
    role: "assistant",
    content: [
      { type: "reasoning", text: "scratch work" },
      { type: "text", text: "answer" },
    ],
  };

  it("stores reasoning for a provider that will replay it", async () => {
    const { createStoredEventFromModelMessage } =
      await import("../src/harness/session.ts");

    const event = createStoredEventFromModelMessage(
      assistantWithReasoning,
      "event",
      { model: "openai/gpt-5.6-luna", retainsReasoning: true },
    );

    expect(event).toEqual({
      version: 1,
      sourceEventId: "event",
      model: "openai/gpt-5.6-luna",
      message: assistantWithReasoning,
    });
  });

  it("drops reasoning nobody sends back rather than storing dead weight", async () => {
    const { createStoredEventFromModelMessage } =
      await import("../src/harness/session.ts");

    const event = createStoredEventFromModelMessage(
      assistantWithReasoning,
      "event",
      { model: "anthropic/claude-opus-5", retainsReasoning: false },
    );

    expect(event).toEqual({
      version: 1,
      sourceEventId: "event",
      model: "anthropic/claude-opus-5",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      },
    });
  });
});

describe("stored item projection", () => {
  const openaiAgentConfig: AgentConfig = {
    provider: { openai: { apiKey: "openai-key" } },
    model: { provider: "openai", modelId: "gpt-5.6-luna" },
  };
  const assistantContent: Exclude<actualAi.AssistantContent, string> = [
    {
      type: "reasoning",
      text: "",
      providerOptions: { openai: { itemId: "rs_1" } },
    },
    {
      type: "text",
      text: "answer",
      providerOptions: { openai: { itemId: "msg_1" } },
    },
  ];
  const assistantMessage: actualAi.AssistantModelMessage = {
    role: "assistant",
    content: assistantContent,
  };

  // One stored assistant row, so the assertion is purely on how projection
  // treats its recorded producer.
  async function projectedMessages(
    model: string | undefined,
  ): Promise<actualAi.ModelMessage[]> {
    const history = await stubHistory([
      {
        cursor: "1",
        event: {
          version: 1,
          sourceEventId: "event",
          ...(model !== undefined ? { model: model } : {}),
          message: assistantMessage,
        },
      },
    ]);
    try {
      const session = await newSession(openaiAgentConfig);

      return (await session.createTurnContext()).messages;
    } finally {
      history.restore();
    }
  }

  it("replays reasoning and item ids back to the model that produced them", async () => {
    expect(await projectedMessages("openai/gpt-5.6-luna")).toEqual([
      assistantMessage,
    ] as actualAi.ModelMessage[]);
  });

  it("drops both when the agent has since moved to another model", async () => {
    expect(await projectedMessages("anthropic/claude-opus-5")).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer", providerOptions: { openai: {} } },
        ],
      },
    ] as actualAi.ModelMessage[]);
  });

  it("drops both on a row stored before producers were recorded", async () => {
    expect(await projectedMessages(undefined)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer", providerOptions: { openai: {} } },
        ],
      },
    ] as actualAi.ModelMessage[]);
  });

  it("drops an abandoned approval's tool call together with its reasoning", async () => {
    const agentConfigs: AgentConfig[] = [
      openaiAgentConfig,
      compactingAgentConfig,
    ];
    for (const agentConfig of agentConfigs) {
      const history = await stubHistory([
        {
          cursor: "1",
          event: {
            version: 1,
            sourceEventId: "event",
            model: `${agentConfig.model?.provider}/${agentConfig.model?.modelId}`,
            message: {
              role: "assistant",
              content: [
                ...assistantContent,
                {
                  type: "tool-call",
                  toolCallId: "call-1",
                  toolName: "bash",
                  input: { shell: "rm file.txt" },
                  providerOptions: { openai: { itemId: "fc_1" } },
                },
                {
                  type: "tool-approval-request",
                  approvalId: "approval-1",
                  toolCallId: "call-1",
                },
              ],
            },
          },
        },
        {
          cursor: "2",
          event: {
            version: 1,
            sourceEventId: "event",
            message: { role: "user", content: "never mind" },
          },
        },
      ]);
      try {
        const session = await newSession({
          ...agentConfig,
          session: undefined,
        });

        expect((await session.createTurnContext()).messages).toEqual([
          {
            role: "assistant",
            content: [
              { type: "text", text: "answer", providerOptions: { openai: {} } },
            ],
          },
          { role: "user", content: "never mind", createdAt: "2" },
        ] as actualAi.ModelMessage[]);
      } finally {
        history.restore();
      }
    }
  });
});

describe("context prepare", () => {
  it("times each load and reads memory and skills once for the whole run", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    process.env.SKILLS_BUCKET_NAME = "skills";
    const memoryIndex = "# Memory Index\n- [Deploys](deploys.md) — how we ship";
    const skillMarkdown =
      "---\nname: review\ndescription: Review a change\n---\nRead the diff.";
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) =>
      key.endsWith("SKILL.md") ? skillMarkdown : memoryIndex,
    );
    const history = await stubHistory(userRows(3));
    try {
      const session = await newSession({
        workspaces: [{ name: "default", workspaceId: "ws_a" }],
        skills: { enabled: true, allowed: ["acct/review"] },
      });
      const turnContext = await session.createTurnContext();

      expect(turnContext.messages).toHaveLength(3);
      expect(turnContext.timings?.phases.historyRows).toBe(3);
      expect(turnContext.timings?.compaction).toBeUndefined();
      // One S3 read for the memory index, one for the skill, before the
      // system prompt was built.
      expect(readS3TextMock).toHaveBeenCalledTimes(2);

      // prepareStep rebuilds the prompt before every step: same reads, no S3.
      const refreshed = await session.loadRefreshedSystemPromptParts({
        systemContextSnapshot: turnContext.systemContextSnapshot,
      });

      expect(readS3TextMock).toHaveBeenCalledTimes(2);
      expect(refreshed.system).toEqual(turnContext.system);
      expect(
        refreshed.system.some((message) =>
          message.content.includes("how we ship"),
        ),
      ).toBe(true);
    } finally {
      history.restore();
    }
  });

  it("ends the prepare window where compaction starts", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "filesystem";
    const history = await stubHistory(userRows(2));
    const { runtime } = await import("../src/shared/convex/runtime.ts");
    const originalMutate = runtime.mutate;
    runtime.mutate = (async () => "cursor") as typeof runtime.mutate;
    try {
      const session = await newSession({
        ...compactingAgentConfig,
        skills: { enabled: false },
      });
      const turnContext = await session.createTurnContext();
      const timings = turnContext.timings;

      expect(generateTextMock).toHaveBeenCalledTimes(1);
      expect(timings?.compaction?.startedMs).toBe(timings!.prepareEndedMs);
      expect(timings!.compaction!.endedMs).toBeGreaterThanOrEqual(
        timings!.compaction!.startedMs,
      );
    } finally {
      history.restore();
      runtime.mutate = originalMutate;
    }
  });
});

describe("session compaction", () => {
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
    expect(createGoogleMock).toHaveBeenCalledWith({
      apiKey: "google-key",
      fetch: expect.any(Function),
    });
    expect(googleModelMock).toHaveBeenCalledWith("gemini-test");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("measures the pruned view, so a stored tool result the model never gets does not trigger it", async () => {
    const { compactSessionContext } =
      await import("../src/harness/compaction.ts");
    const messages = [
      { role: "user", content: "read the log" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tool-call-1",
            toolName: "bash",
            input: { shell: "cat log" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-call-1",
            toolName: "bash",
            output: { type: "text", value: "log line\n".repeat(500) },
          },
        ],
      },
      { role: "assistant", content: "the log is clean" },
      { role: "user", content: "thanks" },
    ] as actualAi.ModelMessage[];
    const compaction = { enabled: true, maxContextLength: 1_000 };

    expect(
      await compactSessionContext({
        conversationKey: "conversation",
        system: [],
        messages: messages,
        agentConfig: {
          ...compactingAgentConfig,
          session: { compaction: compaction },
        },
      }),
    ).toBeNull();
    expect(generateTextMock).not.toHaveBeenCalled();

    // With pruning off the model gets the tool result, so it counts.
    expect(
      await compactSessionContext({
        conversationKey: "conversation",
        system: [],
        messages: messages,
        agentConfig: {
          ...compactingAgentConfig,
          session: { compaction: compaction, pruning: { enabled: false } },
        },
      }),
    ).not.toBeNull();
  });

  it("summarizes on demand regardless of config, folding instructions in", async () => {
    const { summarizeConversation, isCompactionSummaryMessage } =
      await import("../src/harness/compaction.ts");

    const result = await summarizeConversation({
      conversationKey: "conversation",
      priorSummaries: [],
      messages: [
        { role: "assistant", content: "assistant content" },
        { role: "user", content: "trailing user message" },
      ],
      agentConfig: {
        provider: { google: { apiKey: "google-key" } },
        model: { provider: "google" as const, modelId: "gemini-test" },
      },
      instructions: "keep the deploy decisions",
    });

    expect(result).toBeDefined();
    expect(isCompactionSummaryMessage(result!)).toBe(true);
    const options = generateTextMock.mock.calls[0]?.[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    // The manual path passes every message, trailing user message included,
    // and the instructions ride the per-call user message.
    expect(options?.messages[0]?.content).toContain("trailing user message");
    expect(options?.messages[0]?.content).toContain(
      "keep the deploy decisions",
    );
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

/**
 * A session whose identity fields none of these tests assert on. Imported per
 * call rather than at module scope so the mocks above are installed first.
 */
async function newSession(
  agentConfig: AgentConfig,
  conversationKey: string = "conversation",
): Promise<Session> {
  const { Session } = await import("../src/harness/session.ts");

  return new Session({
    eventId: "event",
    conversationKey: conversationKey,
    accountId: "acct",
    agentId: "agent",
    agentConfig: agentConfig,
  });
}

// Replaces the Convex page load with the given rows until restored, so a test
// controls the history a turn starts from.
async function stubHistory(
  page: StoredConversationEventPage["page"],
): Promise<{ restore: () => void }> {
  const { runtime } = await import("../src/shared/convex/runtime.ts");
  const originalQuery = runtime.query;
  runtime.query = (async (name: string) =>
    name === "listConversationEvents"
      ? { page: page, isDone: true, continueCursor: null }
      : null) as typeof runtime.query;

  return {
    restore: (): void => {
      runtime.query = originalQuery;
    },
  };
}

function userRows(count: number): StoredConversationEventPage["page"] {
  return Array.from({ length: count }, (_, index) => ({
    cursor: String(index),
    event: {
      version: 1,
      sourceEventId: "event",
      message: { role: "user", content: `message ${index}` },
    },
  }));
}
