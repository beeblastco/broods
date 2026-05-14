/**
 * Harness tool registry tests.
 * Cover account-configured allowlisting without invoking tool providers.
 */

import { beforeEach, describe, expect, it, mock } from "bun:test";

const tavilySearchMock = mock((options: unknown) => ({ provider: "tavilySearch", options }));
const tavilyExtractMock = mock((options: unknown) => ({ provider: "tavilyExtract", options }));

mock.module("@tavily/ai-sdk", () => ({
  tavilySearch: tavilySearchMock,
  tavilyExtract: tavilyExtractMock,
}));

beforeEach(() => {
  process.env.TAVILY_API_KEY = "tavily-key";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  tavilySearchMock.mockClear();
  tavilyExtractMock.mockClear();
});

describe("createTools", () => {
  it("returns no tools when account config does not list tools", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(createTools(createToolContext(), {})).toEqual({});
    expect(tavilySearchMock).not.toHaveBeenCalled();
    expect(tavilyExtractMock).not.toHaveBeenCalled();
  });

  it("includes only enabled configured tools", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    const tools = createTools(createToolContext(), {
      workspace: {
        enabled: true,
        needsApproval: true,
        tasks: { enabled: true },
      },
      tools: {
        tavilyExtract: { needsApproval: true },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["filesystem", "tasks", "tavilyExtract"]);
    expect(tools.filesystem?.needsApproval).toBe(true);
    expect(tools.tasks?.needsApproval).toBe(true);
    expect(tools.tavilyExtract?.needsApproval).toBe(true);
    expect(tavilySearchMock).not.toHaveBeenCalled();
    expect(tavilyExtractMock).toHaveBeenCalledTimes(1);
  });

  it("can disable individual workspace tools", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    const tools = createTools(createToolContext(), {
      workspace: {
        enabled: true,
        needsApproval: true,
        filesystem: { enabled: false },
        tasks: { enabled: true },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["tasks"]);
    expect(tools.tasks?.needsApproval).toBe(true);
  });

  it("does not expose workspace tools when workspace is disabled", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(createTools(createToolContext(), {
      workspace: {
        enabled: false,
      },
    })).toEqual({});
  });

  it("exposes run_subagent only when subagents are enabled with a dispatcher", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");
    const dispatch = mock(async () => ({
      tasks: [{
        taskId: "subagent_1",
        agentId: "virtual_subagent_1",
        name: "Virtual subagent",
        conversationKey: "subagent-subagent_1",
        statusPath: "/status/subagent_1?agentId=virtual_subagent_1",
        status: "running" as const,
      }],
    }));

    expect(createTools(createToolContext(), {
      subagent: {
        enabled: true,
      },
    })).toEqual({});

    const tools = createTools(createToolContext(undefined, "google", dispatch), {
      subagent: {
        enabled: true,
      },
    });

    expect(Object.keys(tools)).toEqual(["run_subagent"]);
    expect((tools.run_subagent as { execute(input: unknown, options: unknown): Promise<unknown> }).execute({
      tasks: [{
        prompt: "research",
      }],
    }, {
      messages: [{ role: "user", content: "hello" }],
    })).resolves.toEqual({
      tasks: [{
        taskId: "subagent_1",
        agentId: "virtual_subagent_1",
        name: "Virtual subagent",
        conversationKey: "subagent-subagent_1",
        statusPath: "/status/subagent_1?agentId=virtual_subagent_1",
        status: "running",
      }],
    });
    expect(dispatch).toHaveBeenCalledWith([{
      prompt: "research",
    }], [{ role: "user", content: "hello" }]);

    expect((tools.run_subagent as { execute(input: unknown, options: unknown): Promise<unknown> }).execute({
      tasks: [{
        prompt: "research",
        conversationKey: "child",
      }],
    }, {
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("tasks[0].conversationKey is not supported");

    expect((tools.run_subagent as { execute(input: unknown, options: unknown): Promise<unknown> }).execute({
      tasks: [{
        prompt: "research",
        description: "Use a custom child system prompt",
      }],
    }, {
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("tasks[0].description is not supported");
  });

  it("passes provider config into Tavily and Google Search tools", async () => {
    const googleSearchMock = mock((options: unknown) => ({ provider: "googleSearch", options }));
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    const tools = createTools(createToolContext(googleSearchMock), {
      tools: {
        tavilySearch: {
          maxResults: 3,
          includeAnswer: false,
        },
        googleSearch: {
          searchTypes: {
            imageSearch: {},
          },
        },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["googleSearch", "tavilySearch"]);
    expect(tavilySearchMock).toHaveBeenCalledWith({
      apiKey: "tavily-key",
      searchDepth: "advanced",
      includeAnswer: false,
      maxResults: 3,
      topic: "general",
    });
    expect(googleSearchMock).toHaveBeenCalledWith({
      searchTypes: {
        imageSearch: {},
      },
    });
  });

  it("rejects googleSearch for non-Google model providers", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(() => createTools(createToolContext(undefined, "openai"), {
      tools: {
        googleSearch: { enabled: true },
      },
    })).toThrow("config.tools.googleSearch requires config.model.provider to be google");
  });

  it("rejects configured tools without a registered factory", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    expect(() => createTools(createToolContext(), {
      tools: {
        filesystem: { enabled: true },
      },
    })).toThrow("config.tools.filesystem is not a supported tool");
  });
});

function createToolContext(
  googleSearch: ((options: unknown) => unknown) | undefined = mock((_options: unknown) => ({ provider: "googleSearch" })),
  modelProviderName = "google",
  dispatchSubagents?: unknown,
) {
  return {
    conversationKey: "conversation",
    filesystemNamespace: "filesystem",
    modelProviderName,
    modelProvider: {
      tools: {
        googleSearch,
      },
    },
    ...(dispatchSubagents ? { dispatchSubagents } : {}),
  } as never;
}
