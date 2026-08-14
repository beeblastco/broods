/**
 * Harness tool registry tests.
 * Cover agent-configured allowlisting without invoking tool providers.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  ToolExecuteFunction,
  ToolSet,
} from "ai";
import type { ChannelToolContext } from "../src/harness/tools/channel.tool.ts";
import type { ToolContext } from "../src/harness/tools/index.ts";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";
import type { AccountToolRecord } from "../src/shared/domain/account-tools.ts";

const urlContextMock = mock((options: unknown) => ({
  provider: "urlContext",
  options: options,
}));

beforeEach(() => {
  process.env.FILESYSTEM_BUCKET_NAME = "filesystem-bucket";
  urlContextMock.mockClear();
  resetStorageForTests();
});

afterEach(() => {
  resetStorageForTests();
});

describe("createTools", () => {
  it("returns no tools when agent config does not list tools", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    expect(await createTools(createToolContext(), {})).toEqual({});
    expect(urlContextMock).not.toHaveBeenCalled();
  });

  it("automatically exposes channel interaction tools on channel turns", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const sendImage = mock(async function(): Promise<void> {});
    const sendSticker = mock(async function(): Promise<void> {});
    const sendText = mock(async function(): Promise<void> {});
    const reactToMessage = mock(async function(): Promise<void> {});
    const context: Omit<ToolContext, "config"> = {
      ...createToolContext(),
      channel: {
        actions: {
          sendImage: sendImage,
          sendSticker: sendSticker,
          sendText: sendText,
          sendTyping: async function(): Promise<void> {},
          supportsReactions: true,
          reactToMessage: reactToMessage,
        },
        channelName: "zalo",
        transformText: async function(text: string): Promise<string> {
          return `[safe] ${text}`;
        },
      },
    };
    const tools = await createTools(context, {});

    expect(Object.keys(tools).sort()).toEqual([
      "send-image",
      "send-message",
      "send-reactions",
      "send-sticker",
    ]);
    await channelToolExecute(tools["send-message"], { text: "hello" });
    await channelToolExecute(tools["send-image"], {
      url: "https://example.com/image.png",
      caption: "caption",
    });
    await channelToolExecute(tools["send-reactions"], { emoji: "heart" });
    await channelToolExecute(tools["send-sticker"], { sticker: "sticker-1" });

    expect(sendText).toHaveBeenCalledWith("[safe] hello");
    expect(sendImage).toHaveBeenCalledWith(
      "https://example.com/image.png",
      "[safe] caption",
    );
    expect(reactToMessage).toHaveBeenCalledWith("heart");
    expect(sendSticker).toHaveBeenCalledWith("sticker-1");
  });

  it("lets channel denyTools withhold automatic interaction tools", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const context: Omit<ToolContext, "config"> = {
      ...createToolContext(),
      channel: channelToolContext(),
    };
    const tools = await createTools(context, {
      denyTools: ["send-image", "send-sticker"],
    });

    expect(Object.keys(tools).sort()).toEqual([
      "send-message",
      "send-reactions",
    ]);
  });

  it("includes the sandbox bash tool plus enabled configured tools", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const approvalRequirements = new Map<string, true>();
    const context = Object.assign({}, sandboxContext(), {
      approvalRequirements: approvalRequirements,
    }) as never;

    const tools = await createTools(context, {
      tools: {
        urlContext: { needsApproval: true },
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["bash", "urlContext"]);
    await expect(approvalStatus("bash", {}, context)).resolves.toBe(
      "user-approval",
    );
    expect(approvalRequirements.has("urlContext")).toBe(true);
    expect(
      (tools.urlContext as { needsApproval?: unknown })?.needsApproval,
    ).toBeUndefined();
    expect(urlContextMock).toHaveBeenCalledTimes(1);
  });

  it("withholds denied tools including sandbox ones config.tools cannot name", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const context = sandboxContext() as never;

    const tools = await createTools(context, {
      tools: { urlContext: {} },
      denyTools: ["bash", "neverRegistered"],
    });

    // bash comes from the sandbox, not config.tools — naming it there throws
    // "not a supported tool", so the deny list has to apply to the built set.
    expect(Object.keys(tools).sort()).toEqual(["urlContext"]);
  });

  it("withholds a custom tool by the name the model sees, not its tool id", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const toolId = "qs78zwc4z4q5ysxm74fgrhd13s88xxt";
    setStorageForTests(
      storageWithAccountTool({
        accountId: "acct_test",
        toolId: toolId,
        name: "lookup_invoice",
        description: "Uploaded test tool.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
        sha256: "a".repeat(64),
        runtime: "sandbox",
        status: "active",
        createdAt: "2026-06-06T00:00:00.000Z",
        updatedAt: "2026-06-06T00:00:00.000Z",
      }),
    );

    // A record's deny list is written by a human reading the channel, so it
    // names the tool the model is offered — the opaque id must not match.
    expect(
      Object.keys(
        await createTools(createToolContext() as never, {
          tools: { [toolId]: { enabled: true } },
          denyTools: [toolId],
        }),
      ),
    ).toEqual(["lookup_invoice"]);

    expect(
      await createTools(createToolContext() as never, {
        tools: { [toolId]: { enabled: true } },
        denyTools: ["lookup_invoice"],
      }),
    ).toEqual({});
  });

  it("rebuilds a provider tool from an AI SDK descriptor's args", async () => {
    const googleSearchMock = mock((options: unknown) => ({
      provider: "googleSearch",
      options: options,
    }));
    const { createTools } = await import("../src/harness/tools/index.ts");

    // Shape produced by JSON.stringify(google.tools.googleSearch({...})) — the
    // lazy schemas drop out, so only `args` is meaningful.
    const tools = await createTools(createToolContext(googleSearchMock), {
      tools: {
        googleSearch: {
          type: "provider",
          isProviderExecuted: true,
          id: "google.google_search",
          args: { searchTypes: { webSearch: {} } },
        },
      },
    });

    expect(Object.keys(tools)).toEqual(["googleSearch"]);
    expect(googleSearchMock).toHaveBeenCalledWith({
      searchTypes: { webSearch: {} },
    });
  });

  it("rejects a config.tools key the configured provider does not ship", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    await expect(
      createTools(createToolContext(), { tools: { notAProviderTool: {} } }),
    ).rejects.toThrow(
      /config\.tools\.notAProviderTool is not a provider-defined tool/,
    );
  });

  it("exposes only bash when a sandbox has no workspace (stateless)", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const context = sandboxContext();
    const tools = await createTools(context, {});

    expect(Object.keys(tools).sort()).toEqual(["bash"]);
    await expect(approvalStatus("bash", {}, context)).resolves.toBe(
      "user-approval",
    );
  });

  it("exposes the full file tool set when a workspace is attached", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const context = sandboxContext(
      [{ name: "notes", workspaceId: "ws_a", namespace: "fs-a" }],
      "bypass",
    );
    const tools = await createTools(context, {});

    expect(Object.keys(tools).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "memory_save",
      "read",
      "write",
    ]);
    // bypass mode auto-approves everything.
    for (const name of Object.keys(tools)) {
      await expect(approvalStatus(name, {}, context)).resolves.toBeUndefined();
    }
  });

  it("drops memory_save when the workspace harness memory opts out", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const context = sandboxContext(
      [{ name: "notes", workspaceId: "ws_a", namespace: "fs-a" }],
      "bypass",
    ) as { workspaces: Array<{ config: Record<string, unknown> }> };
    context.workspaces[0]!.config = {
      storage: { provider: "s3" },
      harness: { memory: { enabled: false } },
    };
    const tools = await createTools(context as never, {});

    expect(Object.keys(tools).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "read",
      "write",
    ]);
  });

  it("asks before write/edit/bash in `ask` mode but never for read/glob/grep", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const context = sandboxContext(
      [{ name: "notes", workspaceId: "ws_a", namespace: "fs-a" }],
      "ask",
    );
    const tools = await createTools(context, {});

    await expect(approvalStatus("write", {}, context)).resolves.toBe(
      "user-approval",
    );
    await expect(approvalStatus("edit", {}, context)).resolves.toBe(
      "user-approval",
    );
    await expect(approvalStatus("memory_save", {}, context)).resolves.toBe(
      "user-approval",
    );
    await expect(approvalStatus("bash", {}, context)).resolves.toBe(
      "user-approval",
    );
    await expect(approvalStatus("read", {}, context)).resolves.toBeUndefined();
    await expect(approvalStatus("glob", {}, context)).resolves.toBeUndefined();
    await expect(approvalStatus("grep", {}, context)).resolves.toBeUndefined();
  });

  it("exposes only read/glob for a read-only workspace (no sandbox)", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const tools = await createTools(
      {
        conversationKey: "conversation",
        workspaces: [
          {
            name: "ro",
            workspaceId: "ws_ro",
            namespace: "fs-ro",
            config: { storage: { provider: "s3" } },
          },
        ],
        modelProviderName: "google",
        modelProvider: { tools: {} },
      } as never,
      {},
    );

    expect(Object.keys(tools).sort()).toEqual(["glob", "read"]);
    expect(await needsApproval(tools.read)).toBe(false);
    expect(await needsApproval(tools.glob)).toBe(false);
  });

  it("mixes a read-only and a sandbox-backed workspace", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    const tools = await createTools(
      {
        conversationKey: "conversation",
        workspaces: [
          {
            name: "ro",
            workspaceId: "ws_ro",
            namespace: "fs-ro",
            config: { storage: { provider: "s3" } },
          },
          {
            name: "rw",
            workspaceId: "ws_rw",
            namespace: "fs-rw",
            config: { storage: { provider: "s3" } },
            sandbox: { provider: "lambda", permissionMode: "bypass" },
          },
        ],
        modelProviderName: "google",
        modelProvider: { tools: {} },
      } as never,
      {},
    );

    // bash/write/edit/grep/memory_save exist for the sandbox-backed workspace;
    // read/glob span both.
    expect(Object.keys(tools).sort()).toEqual([
      "bash",
      "edit",
      "glob",
      "grep",
      "memory_save",
      "read",
      "write",
    ]);
    // write preserves the real default workspace (ro) instead of silently selecting the
    // later writable one. Because ro is read-only there is no sandbox to approve against,
    // so omitting workspace does NOT prompt — it falls straight through to a clean
    // read-only error.
    expect(await needsApproval(tools.write)).toBe(false);
    await expect(
      (
        tools.write as unknown as { execute(i: unknown): Promise<unknown> }
      ).execute({
        file_path: "a.txt",
        content: "x",
        workspace: "ro",
      }),
    ).rejects.toThrow("Error: workspace is read-only");
    expect(await needsApproval(tools.write, { workspace: "rw" })).toBe(false);
  });

  it("exposes no sandbox tools when no sandbox is referenced", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    expect(await createTools(createToolContext(), {})).toEqual({});
  });

  it("exposes run_subagent only when subagents are enabled with a dispatcher", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const dispatch = mock(async () => ({
      tasks: [
        {
          taskId: "subagent_1",
          agentId: "virtual_subagent_1",
          conversationKey: "subagent-subagent_1",
          statusPath: "/status/subagent_1?agentId=virtual_subagent_1",
          status: "running" as const,
        },
      ],
    }));

    expect(
      await createTools(createToolContext(), {
        subagent: {
          enabled: true,
        },
      }),
    ).toEqual({});

    const tools = await createTools(
      createToolContext(undefined, "google", dispatch),
      {
        subagent: {
          enabled: true,
          mode: "ephemeral",
        },
      },
    );

    expect(Object.keys(tools)).toEqual(["run_subagent"]);
    expect(tools.run_subagent?.description).toContain(
      "Use an available predefined agentId when a listed subagent matches the task",
    );
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
    expect(
      runSubagentSchema.jsonSchema.properties.tasks.items.properties.agentId
        .description,
    ).toContain("Include it when a listed subagent is suitable");
    expect(
      runSubagentSchema.jsonSchema.properties.tasks.items.properties
        .shareContext,
    ).toBeUndefined();

    const defaultModeTools = await createTools(
      createToolContext(undefined, "google", dispatch),
      {
        subagent: {
          enabled: true,
        },
      },
    );
    const defaultModeSchema = defaultModeTools.run_subagent
      ?.inputSchema as unknown as {
      jsonSchema: {
        properties: {
          tasks: { items: { properties: { conversationKey?: unknown } } };
        };
      };
    };
    expect(
      defaultModeSchema.jsonSchema.properties.tasks.items.properties
        .conversationKey,
    ).toBeDefined();
    expect(
      (
        tools.run_subagent as {
          execute(input: unknown, options: unknown): Promise<unknown>;
        }
      ).execute(
        {
          tasks: [
            {
              prompt: "research",
            },
          ],
        },
        {
          messages: [{ role: "user", content: "hello" }],
        },
      ),
    ).resolves.toEqual({
      tasks: [
        {
          taskId: "subagent_1",
          agentId: "virtual_subagent_1",
          conversationKey: "subagent-subagent_1",
          statusPath: "/status/subagent_1?agentId=virtual_subagent_1",
          status: "running",
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith(
      [
        {
          prompt: "research",
        },
      ],
      [{ role: "user", content: "hello" }],
    );
    expect(
      (
        tools.run_subagent as {
          execute(input: unknown, options: unknown): Promise<unknown>;
        }
      ).execute(
        {
          tasks: [
            {
              prompt: "research",
              conversationKey: "child",
            },
          ],
        },
        {
          messages: [{ role: "user", content: "hello" }],
        },
      ),
    ).rejects.toThrow(
      "tasks[0].conversationKey is only supported in persistent mode",
    );

    expect(
      (
        tools.run_subagent as {
          execute(input: unknown, options: unknown): Promise<unknown>;
        }
      ).execute(
        {
          tasks: [
            {
              prompt: "research",
              shareContext: true,
            },
          ],
        },
        {
          messages: [{ role: "user", content: "hello" }],
        },
      ),
    ).rejects.toThrow("tasks[0].shareContext is not supported");

    expect(
      (
        tools.run_subagent as {
          execute(input: unknown, options: unknown): Promise<unknown>;
        }
      ).execute(
        {
          tasks: [
            {
              prompt: "research",
              description: "Use a custom child system prompt",
            },
          ],
        },
        {
          messages: [{ role: "user", content: "hello" }],
        },
      ),
    ).rejects.toThrow("tasks[0].description is not supported");
  });

  it("exposes parent subagent tools only for a persistent session", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const dispatch = mock(async () => ({ tasks: [] }));
    const context = createToolContext(
      undefined,
      "google",
      dispatch,
    ) as unknown as Record<string, unknown>;
    context.session = { eventId: "acct:acct_test:agent:parent:event" };

    expect(
      Object.keys(
        await createTools(context as never, {
          subagent: { enabled: true, mode: "persistent" },
        }),
      ),
    ).toEqual([
      "run_subagent",
      "get_subagent_status",
      "update_subagent",
      "stop_subagent",
    ]);
    expect(
      Object.keys(
        await createTools(context as never, {
          subagent: { enabled: true, mode: "ephemeral" },
        }),
      ),
    ).toEqual(["run_subagent"]);
  });

  it("exposes subagent conversation keys in persistent mode", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const dispatch = mock(async () => ({ tasks: [] }));
    const tools = await createTools(
      createToolContext(undefined, "google", dispatch),
      {
        subagent: {
          enabled: true,
          mode: "persistent",
        },
      },
    );
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

    expect(tools.run_subagent?.description).toContain(
      "Use conversationKey to resume",
    );
    expect(
      runSubagentSchema.jsonSchema.properties.tasks.items.properties
        .conversationKey?.description,
    ).toContain("Existing subagent conversation key");
    await expect(
      (
        tools.run_subagent as {
          execute(input: unknown, options: unknown): Promise<unknown>;
        }
      ).execute(
        {
          tasks: [
            {
              prompt: "continue",
              conversationKey: "subagent-persistent-1",
            },
          ],
        },
        {
          messages: [{ role: "user", content: "hello" }],
        },
      ),
    ).resolves.toEqual({ tasks: [] });
    expect(dispatch).toHaveBeenCalledWith(
      [
        {
          prompt: "continue",
          conversationKey: "subagent-persistent-1",
        },
      ],
      [{ role: "user", content: "hello" }],
    );
  });

  it("passes agent config through to the provider tool factory", async () => {
    const googleSearchMock = mock((options: unknown) => ({
      provider: "googleSearch",
      options: options,
    }));
    const { createTools } = await import("../src/harness/tools/index.ts");

    const tools = await createTools(createToolContext(googleSearchMock), {
      tools: {
        googleSearch: {
          enabled: true,
          searchTypes: {
            imageSearch: {},
          },
        },
        urlContext: {},
      },
    });

    expect(Object.keys(tools).sort()).toEqual(["googleSearch", "urlContext"]);
    // enabled/needsApproval/async are registry-level flags and never reach the
    // provider factory; every other key is passed through as tool args.
    expect(googleSearchMock).toHaveBeenCalledWith({
      searchTypes: {
        imageSearch: {},
      },
    });
    expect(urlContextMock).toHaveBeenCalledWith({});
  });

  it("passes async-enabled provider tools through the async coordinator", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const approvalRequirements = new Map<string, true>();
    const dispatch: NonNullable<ToolContext["dispatchAsyncTools"]> = mock(
      (tools, asyncToolModes): ToolSet => {
        expect([...asyncToolModes.entries()]).toEqual([
          ["googleSearch", "built-in"],
        ]);
        expect(
          (tools.googleSearch as { needsApproval?: unknown }).needsApproval,
        ).toBeUndefined();

        return {
          googleSearch: Object.assign(tools.googleSearch!, { wrapped: true }),
        };
      },
    );

    const googleSearchMock = mock((options: unknown) => ({
      provider: "googleSearch",
      options: options,
      execute: mock(async () => ({ ok: true })),
    }));

    const tools = await createTools(
      Object.assign(
        {},
        createToolContext(googleSearchMock, "google", undefined, dispatch),
        { approvalRequirements: approvalRequirements },
      ) as never,
      {
        tools: {
          googleSearch: {
            async: true,
            needsApproval: true,
            searchTypes: { webSearch: {} },
          },
        },
      },
    );

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((tools.googleSearch as { wrapped?: boolean }).wrapped).toBe(true);
    expect(approvalRequirements.has("googleSearch")).toBe(true);
    expect(googleSearchMock).toHaveBeenCalledWith({
      searchTypes: { webSearch: {} },
    });
  });

  it("registers uploaded account tools by toolId and wraps async by uploaded name", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");
    const approvalRequirements = new Map<string, true>();
    setStorageForTests(
      storageWithAccountTool({
        accountId: "acct_test",
        toolId: "qs78zwc4z4q5ysxm74fgrhd13s88xxt",
        name: "test_async",
        description: "Uploaded async test tool.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        bundleStorageKey: "account-tools/acct_test/bundles/hash.mjs",
        sha256: "a".repeat(64),
        runtime: "sandbox",
        defaultConfig: { fromDefault: true },
        status: "active",
        createdAt: "2026-06-06T00:00:00.000Z",
        updatedAt: "2026-06-06T00:00:00.000Z",
      }),
    );
    const dispatch: NonNullable<ToolContext["dispatchAsyncTools"]> = mock(
      (tools, asyncToolModes): ToolSet => {
        expect(asyncToolModes).toEqual(new Map([["test_async", "uploaded"]]));

        return {
          ...tools,
          test_async: Object.assign(tools.test_async!, { wrapped: true }),
        };
      },
    );

    const tools = await createTools(
      Object.assign(
        {},
        createToolContext(undefined, "google", undefined, dispatch),
        { approvalRequirements: approvalRequirements },
      ) as never,
      {
        tools: {
          qs78zwc4z4q5ysxm74fgrhd13s88xxt: {
            enabled: true,
            async: true,
            needsApproval: true,
            config: { fromAgent: true },
          },
          urlContext: { enabled: true },
        },
      },
    );

    expect(Object.keys(tools).sort()).toEqual([
      "async_status",
      "test_async",
      "urlContext",
    ]);
    expect(tools.test_async?.description).toBe("Uploaded async test tool.");
    expect(tools.test_async?.needsApproval).toBeUndefined();
    expect(approvalRequirements.has("test_async")).toBe(true);
    expect((tools.test_async as { wrapped?: boolean }).wrapped).toBe(true);
    expect(urlContextMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a provider tool the configured provider does not ship", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    await expect(
      createTools(
        Object.assign({}, createToolContext(undefined, "openai"), {
          modelProvider: { tools: { webSearch: mock(() => ({})) } },
        }) as never,
        {
          tools: {
            googleSearch: { enabled: true },
          },
        },
      ),
    ).rejects.toThrow(
      /config\.tools\.googleSearch is not a provider-defined tool on config\.model\.provider 'openai' \(available: webSearch\)/,
    );
  });

  it("rejects configured tools without a registered factory", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    await expect(
      createTools(createToolContext(), {
        tools: {
          bash: { enabled: true },
        },
      }),
    ).rejects.toThrow("config.tools.bash is not a supported tool");
  });
});

function createToolContext(
  googleSearch: ((options: unknown) => unknown) | undefined = mock(
    (_options: unknown) => ({ provider: "googleSearch" }),
  ),
  modelProviderName: ToolContext["modelProviderName"] = "google",
  dispatchSubagents?: ToolContext["dispatchSubagents"],
  dispatchAsyncTools?: ToolContext["dispatchAsyncTools"],
): Omit<ToolContext, "config"> {
  return {
    accountId: "acct_test",
    conversationKey: "conversation",
    modelProviderName: modelProviderName,
    modelProvider: {
      tools: {
        googleSearch: googleSearch,
        urlContext: urlContextMock,
      },
    },
    ...(dispatchSubagents ? { dispatchSubagents: dispatchSubagents } : {}),
    ...(dispatchAsyncTools ? { dispatchAsyncTools: dispatchAsyncTools } : {}),
  };
}

function channelToolContext(): ChannelToolContext {
  return {
    actions: {
      sendImage: async function(): Promise<void> {},
      sendSticker: async function(): Promise<void> {},
      sendText: async function(): Promise<void> {},
      sendTyping: async function(): Promise<void> {},
      supportsReactions: true,
      reactToMessage: async function(): Promise<void> {},
    },
    channelName: "test",
    transformText: async function(text: string): Promise<string> {
      return text;
    },
  };
}

async function channelToolExecute(
  candidate: ToolSet[string] | undefined,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (!isChannelTestTool(candidate)) {
    throw new Error("Expected an executable channel tool");
  }
  const execute: ChannelTestTool["execute"] = candidate.execute;

  return execute(input, {
    toolCallId: "channel-tool-test",
    messages: [],
    context: {},
  });
}

interface ChannelTestTool {
  execute: ToolExecuteFunction<
    Record<string, unknown>,
    unknown,
    Record<string, unknown>
  >;
}

function isChannelTestTool(
  candidate: ToolSet[string] | undefined,
): candidate is ToolSet[string] & ChannelTestTool {
  return typeof candidate?.execute === "function";
}

function storageWithAccountTool(accountTool: AccountToolRecord): Storage {
  return {
    accounts: {} as never,
    agents: {} as never,
    channelRecords: {} as never,
    agentDeployments: {
      getByApiKeyHash: async function () {
        return null;
      },
    },
    crons: {} as never,
    sandboxConfigs: {} as never,
    workspaceConfigs: {} as never,
    agentPolicies: {} as never,
    accountTools: {
      getById: async function (accountId: string, toolId: string) {
        const record = accountTool as { accountId: string; toolId: string };

        return record.accountId === accountId && record.toolId === toolId
          ? accountTool
          : null;
      },
      list: async function () {
        return [accountTool];
      },
      create: mock() as never,
      update: mock() as never,
      remove: mock() as never,
      removeAllForAccount: mock() as never,
    },
    accountHooks: {} as never,
    taskUsage: { record: async function () {} },
  } as Storage;
}

function sandboxContext(
  workspaces: Array<{
    name: string;
    workspaceId: string;
    namespace: string;
  }> = [],
  permissionMode = "ask",
) {
  return {
    accountId: "acct_test",
    conversationKey: "conversation",
    agentSandbox: { provider: "lambda" },
    agentSandboxPermissionMode: permissionMode,
    // Each workspace carries its own effective sandbox (its permissionMode lives on it).
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      config: { storage: { provider: "s3" } },
      sandbox: { provider: "lambda", permissionMode: permissionMode },
    })),
    modelProviderName: "google",
    modelProvider: { tools: { urlContext: urlContextMock } },
  } as never;
}

async function approvalStatus(
  toolName: string,
  input: Record<string, unknown>,
  ctx: {
    workspaces?: unknown[];
    agentSandbox?: unknown;
    agentSandboxPermissionMode?: unknown;
    approvalRequirements?: Map<string, true>;
  },
) {
  const { compatibilityApprovalStatus } =
    await import("../src/harness/policy.ts");

  return compatibilityApprovalStatus(toolName, input, {
    configuredApprovals: ctx.approvalRequirements ?? new Map(),
    workspaces: (ctx.workspaces ?? []) as never,
    ...(ctx.agentSandbox ? { agentSandbox: ctx.agentSandbox as never } : {}),
    ...(typeof ctx.agentSandboxPermissionMode === "string"
      ? { agentSandboxPermissionMode: ctx.agentSandboxPermissionMode as never }
      : {}),
  });
}

// v7 approval lives on harness-level toolApproval. Tool definitions should not
// carry legacy needsApproval; normalize the absence to false where tests only
// need to verify auto-approved tools stay clean.
async function needsApproval(
  entry: unknown,
  input: Record<string, unknown> = {},
): Promise<boolean> {
  const value = (entry as { needsApproval?: unknown }).needsApproval;
  if (typeof value === "function") {
    return Boolean(await value(input, { toolCallId: "t", messages: [] }));
  }

  return value === true;
}
