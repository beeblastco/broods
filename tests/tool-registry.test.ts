/**
 * Harness tool registry tests.
 * Cover agent-configured allowlisting without invoking tool providers.
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
  it("returns no tools when agent config does not list tools", async () => {
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
      },
      tools: {
        tavilyExtract: { needsApproval: true },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["bash", "tavilyExtract"]);
    expect(tools.bash?.needsApproval).toBe(true);
    expect(tools.tavilyExtract?.needsApproval).toBe(true);
    expect(tavilySearchMock).not.toHaveBeenCalled();
    expect(tavilyExtractMock).toHaveBeenCalledTimes(1);
  });

  it("always exposes only bash when workspace is enabled", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    const tools = createTools(createToolContext(), {
      workspace: {
        enabled: true,
        needsApproval: true,
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["bash"]);
    expect(tools.bash?.needsApproval).toBe(true);
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
    expect(tools.run_subagent?.description).toContain("Use an available predefined agentId when a listed subagent matches the task");
    const runSubagentSchema = tools.run_subagent?.inputSchema as unknown as {
      jsonSchema: {
        properties: {
          tasks: {
            items: {
              properties: {
                agentId: { description: string };
                shareContext?: unknown;
              };
            };
          };
        };
      };
    };
    expect(runSubagentSchema.jsonSchema.properties.tasks.items.properties.agentId.description)
      .toContain("Include it when a listed subagent is suitable");
    expect(runSubagentSchema.jsonSchema.properties.tasks.items.properties.shareContext).toBeUndefined();
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
        conversationKey: "subagent-subagent_1",
        statusPath: "/status/subagent_1?agentId=virtual_subagent_1",
        status: "running",
      }],
    });
    expect(dispatch).toHaveBeenCalledWith([{
      prompt: "research",
    }], [{ role: "user", content: "hello" }]);
    expect((tools.run_subagent as {
      toModelOutput(options: { toolCallId: string; input: unknown; output: unknown }): unknown;
    }).toModelOutput({
      toolCallId: "tool-call-1",
      input: {},
      output: { tasks: [{ taskId: "subagent_1", status: "running" }] },
    })).toEqual({
      type: "json",
      value: { tasks: [{ taskId: "subagent_1", status: "running" }] },
    });

    expect((tools.run_subagent as { execute(input: unknown, options: unknown): Promise<unknown> }).execute({
      tasks: [{
        prompt: "research",
        conversationKey: "child",
      }],
    }, {
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("tasks[0].conversationKey is only supported in persistent mode");

    expect((tools.run_subagent as { execute(input: unknown, options: unknown): Promise<unknown> }).execute({
      tasks: [{
        prompt: "research",
        shareContext: true,
      }],
    }, {
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("tasks[0].shareContext is not supported");

    expect((tools.run_subagent as { execute(input: unknown, options: unknown): Promise<unknown> }).execute({
      tasks: [{
        prompt: "research",
        description: "Use a custom child system prompt",
      }],
    }, {
      messages: [{ role: "user", content: "hello" }],
    })).rejects.toThrow("tasks[0].description is not supported");
  });

  it("exposes subagent conversation keys in persistent mode", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");
    const dispatch = mock(async () => ({ tasks: [] }));
    const tools = createTools(createToolContext(undefined, "google", dispatch), {
      subagent: {
        enabled: true,
        mode: "persistent",
      },
    });
    const runSubagentSchema = tools.run_subagent?.inputSchema as unknown as {
      jsonSchema: {
        properties: {
          tasks: {
            items: {
              properties: {
                conversationKey?: { description: string };
              };
            };
          };
        };
      };
    };

    expect(tools.run_subagent?.description).toContain("Use conversationKey to resume");
    expect(runSubagentSchema.jsonSchema.properties.tasks.items.properties.conversationKey?.description)
      .toContain("Existing subagent conversation key");
    await expect((tools.run_subagent as { execute(input: unknown, options: unknown): Promise<unknown> }).execute({
      tasks: [{
        prompt: "continue",
        conversationKey: "subagent-persistent-1",
      }],
    }, {
      messages: [{ role: "user", content: "hello" }],
    })).resolves.toEqual({ tasks: [] });
    expect(dispatch).toHaveBeenCalledWith([{
      prompt: "continue",
      conversationKey: "subagent-persistent-1",
    }], [{ role: "user", content: "hello" }]);
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

  it("registers the handoff tool from config.tools", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");

    const tools = createTools(createToolContext(), {
      tools: {
        handoffs: {
          enabled: true,
          pancake: {
            scenarioTagIds: {
              order: "order-tag",
              pending: "pending-tag",
            },
          },
          zalo: {
            botToken: "zalo-token",
            notifyUserIds: ["sale-1"],
          },
        },
      },
    });

    expect(Object.keys(tools)).toEqual(["handoffs"]);
  });

  it("passes async-enabled external tools through the async coordinator", async () => {
    const { createTools } = await import("../functions/harness-processing/tools/index.ts");
    const dispatch = mock((tools: Record<string, unknown>, asyncToolModes: Map<string, string>) => {
      expect([...asyncToolModes.entries()]).toEqual([["tavilySearch", "external-dispatch"]]);
      expect((tools.tavilySearch as { needsApproval?: boolean }).needsApproval).toBe(true);
      return {
        tavilySearch: {
          ...(tools.tavilySearch as object),
          wrapped: true,
        },
      };
    });

    tavilySearchMock.mockImplementationOnce((options: unknown) => ({
      provider: "tavilySearch",
      options,
      execute: mock(async () => ({ ok: true })),
    }));

    const tools = createTools(createToolContext(undefined, "google", undefined, dispatch), {
      tools: {
        tavilySearch: {
          async: true,
          execution: "external-dispatch",
          needsApproval: true,
          maxResults: 2,
        },
      },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((tools.tavilySearch as { wrapped?: boolean }).wrapped).toBe(true);
    expect(tavilySearchMock).toHaveBeenCalledWith({
      apiKey: "tavily-key",
      searchDepth: "advanced",
      includeAnswer: true,
      maxResults: 2,
      topic: "general",
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
        bash: { enabled: true },
      },
    })).toThrow("config.tools.bash is not a supported tool");
  });
});

function createToolContext(
  googleSearch: ((options: unknown) => unknown) | undefined = mock((_options: unknown) => ({ provider: "googleSearch" })),
  modelProviderName = "google",
  dispatchSubagents?: unknown,
  dispatchAsyncTools?: unknown,
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
    ...(dispatchAsyncTools ? { dispatchAsyncTools } : {}),
  } as never;
}
