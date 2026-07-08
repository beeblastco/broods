/**
 * Harness tool registry tests.
 * Cover agent-configured allowlisting without invoking tool providers.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  resetStorageForTests,
  setStorageForTests,
  type AccountToolRecord,
  type StorageProvider,
} from "../src/shared/storage/index.ts";

const tavilySearchMock = mock((options: unknown) => ({ provider: "tavilySearch", options }));
const tavilyExtractMock = mock((options: unknown) => ({ provider: "tavilyExtract", options }));

mock.module("@tavily/ai-sdk", () => ({
  tavilySearch: tavilySearchMock,
  tavilyExtract: tavilyExtractMock,
}));

beforeEach(() => {
  process.env.TAVILY_API_KEY = "tavily-key";
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  process.env.ASYNC_TOOL_RESULT_TABLE_NAME = "async-tool-results";
  tavilySearchMock.mockClear();
  tavilyExtractMock.mockClear();
  resetStorageForTests();
});

afterEach(() => {
  resetStorageForTests();
});

describe("createTools", () => {
  it("returns no tools when agent config does not list tools", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    expect(await createTools(createToolContext(), {})).toEqual({});
    expect(tavilySearchMock).not.toHaveBeenCalled();
    expect(tavilyExtractMock).not.toHaveBeenCalled();
  });

  it("includes the sandbox bash tool plus enabled configured tools", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const approvalRequirements = new Map<string, true>();
    const context = Object.assign({}, sandboxContext(), { approvalRequirements }) as never;

    const tools = await createTools(context, {
      tools: {
        tavilyExtract: { needsApproval: true },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["bash", "tavilyExtract"]);
    await expect(approvalStatus("bash", {}, context)).resolves.toBe("user-approval");
    expect(approvalRequirements.has("tavilyExtract")).toBe(true);
    expect((tools.tavilyExtract as { needsApproval?: unknown })?.needsApproval).toBeUndefined();
    expect(tavilySearchMock).not.toHaveBeenCalled();
    expect(tavilyExtractMock).toHaveBeenCalledTimes(1);
  });

  it("exposes only bash when a sandbox has no workspace (stateless)", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const context = sandboxContext();
    const tools = await createTools(context, {});

    expect(Object.keys(tools).sort()).toEqual(["bash"]);
    await expect(approvalStatus("bash", {}, context)).resolves.toBe("user-approval");
  });

  it("exposes the full file tool set when a workspace is attached", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const context = sandboxContext([
      { name: "notes", workspaceId: "ws_a", namespace: "fs-a" },
    ], "bypass");
    const tools = await createTools(context, {});

    expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "glob", "grep", "read", "write"]);
    // bypass mode auto-approves everything.
    for (const name of Object.keys(tools)) {
      await expect(approvalStatus(name, {}, context)).resolves.toBeUndefined();
    }
  });

  it("asks before write/edit/bash in `ask` mode but never for read/glob/grep", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const context = sandboxContext([
      { name: "notes", workspaceId: "ws_a", namespace: "fs-a" },
    ], "ask");
    const tools = await createTools(context, {});

    await expect(approvalStatus("write", {}, context)).resolves.toBe("user-approval");
    await expect(approvalStatus("edit", {}, context)).resolves.toBe("user-approval");
    await expect(approvalStatus("bash", {}, context)).resolves.toBe("user-approval");
    await expect(approvalStatus("read", {}, context)).resolves.toBeUndefined();
    await expect(approvalStatus("glob", {}, context)).resolves.toBeUndefined();
    await expect(approvalStatus("grep", {}, context)).resolves.toBeUndefined();
  });

  it("exposes only read/glob for a read-only workspace (no sandbox)", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const tools = await createTools({
      conversationKey: "conversation",
      workspaces: [
        { name: "ro", workspaceId: "ws_ro", namespace: "fs-ro", config: { storage: { provider: "s3" } } },
      ],
      modelProviderName: "google",
      modelProvider: { tools: {} },
    } as never, {});

    expect(Object.keys(tools).sort()).toEqual(["glob", "read"]);
    expect(await needsApproval(tools.read)).toBe(false);
    expect(await needsApproval(tools.glob)).toBe(false);
  });

  it("mixes a read-only and a sandbox-backed workspace", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const tools = await createTools({
      conversationKey: "conversation",
      workspaces: [
        { name: "ro", workspaceId: "ws_ro", namespace: "fs-ro", config: { storage: { provider: "s3" } } },
        { name: "rw", workspaceId: "ws_rw", namespace: "fs-rw", config: { storage: { provider: "s3" } }, sandbox: { provider: "lambda", permissionMode: "bypass" } },
      ],
      modelProviderName: "google",
      modelProvider: { tools: {} },
    } as never, {});

    // bash/write/edit/grep exist for the sandbox-backed workspace; read/glob span both.
    expect(Object.keys(tools).sort()).toEqual(["bash", "edit", "glob", "grep", "read", "write"]);
    // write preserves the real default workspace (ro) instead of silently selecting the
    // later writable one. Because ro is read-only there is no sandbox to approve against,
    // so omitting workspace does NOT prompt — it falls straight through to a clean
    // read-only error.
    expect(await needsApproval(tools.write)).toBe(false);
    expect(await (tools.write as unknown as { execute(i: unknown): Promise<unknown> }).execute({
      file_path: "a.txt",
      content: "x",
      workspace: "ro",
    })).toEqual({ type: "error-text", value: "Error: workspace is read-only" });
    expect(await needsApproval(tools.write, { workspace: "rw" })).toBe(false);
  });

  it("exposes no sandbox tools when no sandbox is referenced", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    expect(await createTools(createToolContext(), {})).toEqual({});
  });

  it("exposes run_subagent only when subagents are enabled with a dispatcher", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const dispatch = mock(async () => ({
      tasks: [{
        taskId: "subagent_1",
        agentId: "virtual_subagent_1",
        conversationKey: "subagent-subagent_1",
        statusPath: "/status/subagent_1?agentId=virtual_subagent_1",
        status: "running" as const,
      }],
    }));

    expect(await createTools(createToolContext(), {
      subagent: {
        enabled: true,
      },
    })).toEqual({});

    const tools = await createTools(createToolContext(undefined, "google", dispatch), {
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
    const { createTools } = await import("../src/harness/tools/index.ts");
    const dispatch = mock(async () => ({ tasks: [] }));
    const tools = await createTools(createToolContext(undefined, "google", dispatch), {
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
    const { createTools } = await import("../src/harness/tools/index.ts");

    const tools = await createTools(createToolContext(googleSearchMock), {
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
    const { createTools } = await import("../src/harness/tools/index.ts");

    const tools = await createTools(createToolContext(), {
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

  it("passes async-enabled built-in tools through the async coordinator", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const approvalRequirements = new Map<string, true>();
    const dispatch = mock((tools: Record<string, unknown>, asyncToolModes: Map<string, string>) => {
      expect([...asyncToolModes.entries()]).toEqual([["tavilySearch", "built-in"]]);
      expect((tools.tavilySearch as { needsApproval?: unknown }).needsApproval).toBeUndefined();
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

    const tools = await createTools(Object.assign(
      {},
      createToolContext(undefined, "google", undefined, dispatch),
      { approvalRequirements },
    ) as never, {
      tools: {
        tavilySearch: {
          async: true,
          needsApproval: true,
          maxResults: 2,
        },
      },
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((tools.tavilySearch as { wrapped?: boolean }).wrapped).toBe(true);
    expect(approvalRequirements.has("tavilySearch")).toBe(true);
    expect(tavilySearchMock).toHaveBeenCalledWith({
      apiKey: "tavily-key",
      searchDepth: "advanced",
      includeAnswer: true,
      maxResults: 2,
      topic: "general",
    });
  });

  it("registers uploaded account tools by toolId and wraps async by uploaded name", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const approvalRequirements = new Map<string, true>();
    setStorageForTests(storageWithAccountTool({
      accountId: "acct_test",
      toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxtv",
      name: "test_async",
      description: "Uploaded async test tool.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
      sha256: "a".repeat(64),
      runtime: "sandbox",
      defaultConfig: { fromDefault: true },
      status: "active",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    }));
    const dispatch = mock((tools: Record<string, unknown>, asyncToolModes: Map<string, string>) => {
      expect(asyncToolModes).toEqual(new Map([["test_async", "uploaded"]]));
      return {
        ...tools,
        test_async: {
          ...(tools.test_async as object),
          wrapped: true,
        },
      };
    });

    const tools = await createTools(Object.assign(
      {},
      createToolContext(undefined, "google", undefined, dispatch),
      { approvalRequirements },
    ) as never, {
      tools: {
        qs78zwc4z4q5ysxm74fgrhd13s88xxtv: {
          enabled: true,
          async: true,
          needsApproval: true,
          config: { fromAgent: true },
        },
        tavilyExtract: { enabled: true },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["async_status", "tavilyExtract", "test_async"]);
    expect(tools.test_async?.description).toBe("Uploaded async test tool.");
    expect(tools.test_async?.needsApproval).toBeUndefined();
    expect(approvalRequirements.has("test_async")).toBe(true);
    expect((tools.test_async as { wrapped?: boolean }).wrapped).toBe(true);
    expect(tavilyExtractMock).toHaveBeenCalledTimes(1);
  });

  it("rejects googleSearch for non-Google model providers", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    await expect(createTools(createToolContext(undefined, "openai"), {
      tools: {
        googleSearch: { enabled: true },
      },
    })).rejects.toThrow("config.tools.googleSearch requires config.model.provider to be google");
  });

  it("rejects configured tools without a registered factory", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    await expect(createTools(createToolContext(), {
      tools: {
        bash: { enabled: true },
      },
    })).rejects.toThrow("config.tools.bash is not a supported tool");
  });
});

function createToolContext(
  googleSearch: ((options: unknown) => unknown) | undefined = mock((_options: unknown) => ({ provider: "googleSearch" })),
  modelProviderName = "google",
  dispatchSubagents?: unknown,
  dispatchAsyncTools?: unknown,
) {
  return {
    accountId: "acct_test",
    conversationKey: "conversation",
    permissionMode: "ask",
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

function storageWithAccountTool(accountTool: AccountToolRecord): StorageProvider {
  return {
    kind: "dynamodb",
    accounts: {} as never,
    agents: {} as never,
    agentDeployments: {
      async getByApiKeyHash() {
        return null;
      },
    },
    crons: {} as never,
    sandboxConfigs: {} as never,
    workspaceConfigs: {} as never,
    agentPolicies: {} as never,
    accountTools: {
      async getById(accountId: string, toolId: string) {
        const record = accountTool as { accountId: string; toolId: string };
        return record.accountId === accountId && record.toolId === toolId ? accountTool : null;
      },
      async list() {
        return [accountTool];
      },
      create: mock() as never,
      update: mock() as never,
      remove: mock() as never,
      removeAllForAccount: mock() as never,
    },
    accountHooks: {} as never,
    usage: { async recordTask() {} },
  } as StorageProvider;
}

function sandboxContext(
  workspaces: Array<{ name: string; workspaceId: string; namespace: string }> = [],
  permissionMode = "ask",
) {
  return {
    accountId: "acct_test",
    conversationKey: "conversation",
    statelessSandbox: { provider: "lambda" },
    statelessPermissionMode: permissionMode,
    // Each workspace carries its own effective sandbox (its permissionMode lives on it).
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      config: { storage: { provider: "s3" } },
      sandbox: { provider: "lambda", permissionMode },
    })),
    modelProviderName: "google",
    modelProvider: { tools: {} },
  } as never;
}

async function approvalStatus(toolName: string, input: Record<string, unknown>, ctx: {
  workspaces?: unknown[];
  statelessSandbox?: unknown;
  statelessPermissionMode?: unknown;
  approvalRequirements?: Map<string, true>;
}) {
  const { compatibilityApprovalStatus } = await import("../src/harness/policy.ts");
  return compatibilityApprovalStatus(toolName, input, {
    configuredApprovals: ctx.approvalRequirements ?? new Map(),
    workspaces: (ctx.workspaces ?? []) as never,
    ...(ctx.statelessSandbox ? { statelessSandbox: ctx.statelessSandbox as never } : {}),
    ...(typeof ctx.statelessPermissionMode === "string" ? { statelessPermissionMode: ctx.statelessPermissionMode as never } : {}),
  });
}

// v7 approval lives on harness-level toolApproval. Tool definitions should not
// carry legacy needsApproval; normalize the absence to false where tests only
// need to verify auto-approved tools stay clean.
async function needsApproval(entry: unknown, input: Record<string, unknown> = {}): Promise<boolean> {
  const value = (entry as { needsApproval?: unknown }).needsApproval;
  if (typeof value === "function") {
    return Boolean(await value(input, { toolCallId: "t", messages: [] }));
  }
  return value === true;
}
