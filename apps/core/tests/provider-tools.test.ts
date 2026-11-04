import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import { tool, type ToolSet } from "ai";
import type { ToolContext } from "../src/harness/tools/index.ts";
import type { ResolvedWorkspace } from "../src/shared/workspaces.ts";

const anthropic = createAnthropic({ apiKey: "test" });
const openai = createOpenAI({ apiKey: "test" });
const calls: Array<{ tool: string; input: unknown }> = [];

// Records what each Broods sandbox tool was asked to do; a stand-in must route through these.
function fakeTool(name: string, output: string = `${name} ran`): ToolSet {
  return {
    [name]: tool({
      description: name,
      inputSchema: { type: "object" } as never,
      execute: async (input: unknown): Promise<string> => {
        calls.push({ tool: name, input: input });

        return output;
      },
    }),
  };
}

await mock.module("../src/harness/tools/bash.tool.ts", () => ({
  default: (): ToolSet => fakeTool("bash", "hi\n[exit code 3]"),
}));
await mock.module("../src/harness/tools/read.tool.ts", () => ({
  default: (): ToolSet => fakeTool("read"),
}));
await mock.module("../src/harness/tools/write.tool.ts", () => ({
  default: (): ToolSet => fakeTool("write"),
}));
await mock.module("../src/harness/tools/edit.tool.ts", () => ({
  default: (): ToolSet => fakeTool("edit"),
}));

describe("provider tools by id", () => {
  it("resolves an AI SDK descriptor under any key", async () => {
    const tools = await build("anthropic", anthropic, {
      webSearch: descriptor(anthropic.tools.webSearch_20260318({ maxUses: 2 })),
      fetcher: descriptor(anthropic.tools.webFetch_20260318({})),
      sandbox: descriptor(anthropic.tools.codeExecution_20260120()),
    });

    expect(tools.webSearch).toMatchObject({
      id: "anthropic.web_search_20260318",
      isProviderExecuted: true,
      args: { maxUses: 2 },
    });
    expect(tools.fetcher).toMatchObject({ id: "anthropic.web_fetch_20260318" });
    expect(tools.sandbox).toMatchObject({
      id: "anthropic.code_execution_20260120",
    });
  });

  it("resolves OpenAI, Google and xAI hosted tools by id", async () => {
    const google = createGoogle({ apiKey: "test" });
    const xai = createXai({ apiKey: "test" });

    expect(
      (
        await build("openai", openai, {
          search: descriptor(openai.tools.webSearch({})),
          python: descriptor(
            openai.tools.codeInterpreter({ container: { fileIds: [] } }),
          ),
          hostedShell: descriptor(
            openai.tools.shell({ environment: { type: "containerAuto" } }),
          ),
          find: descriptor(openai.tools.toolSearch({})),
        })
      ).find,
    ).toMatchObject({ id: "openai.tool_search", execute: undefined });
    expect(
      (
        await build("google", google, {
          search: descriptor(google.tools.googleSearch({})),
        })
      ).search,
    ).toMatchObject({ id: "google.google_search" });
    expect(
      (await build("xai", xai, { x: descriptor(xai.tools.xSearch({})) })).x,
    ).toMatchObject({ id: "xai.x_search" });
  });

  it("names the ids the provider ships when one is missing", async () => {
    await expect(
      build("openai", openai, {
        webSearch: descriptor(anthropic.tools.webSearch_20260318({})),
      }),
    ).rejects.toThrow(
      /config\.tools\.webSearch \(anthropic\.web_search_20260318\) is not a provider-defined tool .*openai\.web_search/,
    );
  });

  it("refuses a Broods tool name for a tool that does not run as it", async () => {
    await expect(
      build("anthropic", anthropic, {
        read: descriptor(anthropic.tools.webSearch_20260318({})),
      }),
    ).rejects.toThrow(/config\.tools\.read is a Broods tool name/);
  });

  it("refuses a key that names a tool Broods already registered", async () => {
    const { createTools } = await import("../src/harness/tools/index.ts");

    expect(
      createTools(
        {
          accountId: "acct_test",
          conversationKey: "conversation",
          modelProviderName: "anthropic",
          modelProvider: anthropic,
          sandboxes: [{ name: "mac", sandbox: { provider: "machine" } }],
        },
        {
          tools: {
            computer: descriptor(anthropic.tools.webSearch_20260318({})),
          },
        },
      ),
    ).rejects.toThrow(/config\.tools\.computer is a Broods tool name/);
  });

  it("refuses a client-executed tool Broods cannot run", async () => {
    await expect(
      build("anthropic", anthropic, {
        computer: descriptor(
          anthropic.tools.computer_20251124({
            displayWidthPx: 800,
            displayHeightPx: 600,
          }),
        ),
      }),
    ).rejects.toThrow(/runs in the caller's code/);
  });
});

describe("client-executed provider tools on the sandbox", () => {
  it("runs Anthropic bash as Broods bash, in its place", async () => {
    const standIns = new Map();
    const tools = await build(
      "anthropic",
      anthropic,
      { bash: descriptor(anthropic.tools.bash_20250124({})) },
      standIns,
    );

    expect(tools.bash).toMatchObject({ id: "anthropic.bash_20250124" });
    expect(await run(tools.bash, { command: "ls" })).toBe("hi\n[exit code 3]");
    expect(calls).toEqual([{ tool: "bash", input: { command: "ls" } }]);
    expect(standIns.get("bash").toSandboxCall({ command: "ls" })).toEqual({
      toolName: "bash",
      input: { command: "ls" },
    });
  });

  it("withholds a stand-in when denyTools names the tool it runs as", async () => {
    const tools = await build(
      "openai",
      openai,
      { shell: descriptor(openai.tools.shell({})) },
      new Map(),
      ["bash"],
    );

    expect(tools.shell).toBeUndefined();
    expect(tools.bash).toBeUndefined();
  });

  it("gives back the Broods tools a withheld stand-in replaced and denyTools allows", async () => {
    const tools = await build(
      "anthropic",
      anthropic,
      {
        str_replace_based_edit_tool: descriptor(
          anthropic.tools.textEditor_20250728({}),
        ),
      },
      new Map(),
      ["write"],
    );

    expect(tools.str_replace_based_edit_tool).toBeUndefined();
    expect(tools.write).toBeUndefined();
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining(["read", "edit"]),
    );
  });

  it("judges an apply_patch update as an edit", async () => {
    const standIns = new Map();
    await build(
      "openai",
      openai,
      { apply_patch: descriptor(openai.tools.applyPatch({})) },
      standIns,
    );
    const toSandboxCall = standIns.get("apply_patch").toSandboxCall;

    expect(
      toSandboxCall({
        operation: { type: "update_file", path: "a.ts", diff: "" },
      }),
    ).toEqual({ toolName: "edit", input: { file_path: "a.ts" } });
    expect(
      toSandboxCall({ operation: { type: "delete_file", path: "a.ts" } }),
    ).toEqual({ toolName: "write", input: { file_path: "a.ts" } });
  });

  it("maps OpenAI shell commands to one output each", async () => {
    const tools = await build("openai", openai, {
      shell: descriptor(openai.tools.shell({})),
    });

    expect(tools.bash).toBeUndefined();
    expect(
      await run(tools.shell, { action: { commands: ["ls", "pwd"] } }),
    ).toEqual({
      output: [
        {
          stdout: "hi\n[exit code 3]",
          stderr: "",
          outcome: { type: "exit", exitCode: 3 },
        },
        {
          stdout: "hi\n[exit code 3]",
          stderr: "",
          outcome: { type: "exit", exitCode: 3 },
        },
      ],
    });
  });

  it("quotes an OpenAI local shell argv", async () => {
    const tools = await build("openai", openai, {
      local_shell: descriptor(openai.tools.localShell({})),
    });

    await run(tools.local_shell, {
      action: { type: "exec", command: ["echo", "a b"], workingDirectory: "x" },
    });
    expect(calls).toEqual([
      { tool: "bash", input: { command: "cd 'x' && 'echo' 'a b'" } },
    ]);
  });

  it("routes each text editor command to read, write or edit", async () => {
    const standIns = new Map();
    const tools = await build(
      "anthropic",
      anthropic,
      {
        str_replace_based_edit_tool: descriptor(
          anthropic.tools.textEditor_20250728({}),
        ),
      },
      standIns,
    );
    const editor = tools.str_replace_based_edit_tool;

    await run(editor, { command: "view", path: "a.ts", view_range: [3, 4] });
    await run(editor, { command: "create", path: "b.ts", file_text: "x" });
    await run(editor, {
      command: "str_replace",
      path: "a.ts",
      old_str: "1",
      new_str: "2",
    });
    expect(calls).toEqual([
      { tool: "read", input: { file_path: "a.ts", offset: 3, limit: 2 } },
      { tool: "write", input: { file_path: "b.ts", content: "x" } },
      {
        tool: "edit",
        input: { file_path: "a.ts", old_string: "1", new_string: "2" },
      },
    ]);
    expect(
      standIns
        .get("str_replace_based_edit_tool")
        .toSandboxCall({ command: "create", path: "b.ts", file_text: "x" }),
    ).toEqual({
      toolName: "write",
      input: { file_path: "b.ts", content: "x" },
    });
    expect(
      standIns.get("str_replace_based_edit_tool").toSandboxCall({
        command: "insert",
        path: "a.ts",
        insert_line: 2,
        insert_text: "y",
      }),
    ).toEqual({
      toolName: "edit",
      input: { file_path: "a.ts", insert_line: 2, new_string: "y" },
    });
    expect(tools.read).toBeUndefined();
  });

  it("refuses a stand-in on an agent with a workspace to pick", async () => {
    await expect(
      build(
        "anthropic",
        anthropic,
        {
          str_replace_based_edit_tool: descriptor(
            anthropic.tools.textEditor_20250728({}),
          ),
        },
        new Map(),
        undefined,
        ["docs"],
      ),
    ).rejects.toThrow(/has no input to pick a workspace or sandbox/);
  });

  it("pipes an OpenAI custom tool's text to its command", async () => {
    const tools = await build("openai", openai, {
      write_sql: {
        ...descriptor(openai.tools.customTool({ description: "SQL" })),
        command: "sqlite3 data.db",
      },
    });

    await run(tools.write_sql, "SELECT * FROM f WHERE p LIKE '../%'");
    await run(tools.write_sql, "a\nBROODS_INPUT\nb");
    expect(calls).toEqual([
      {
        tool: "bash",
        input: {
          command:
            "sqlite3 data.db <<'BROODS_INPUT'\nSELECT * FROM f WHERE p LIKE '../%'\nBROODS_INPUT",
        },
      },
      {
        tool: "bash",
        input: {
          command:
            "sqlite3 data.db <<'BROODS_INPUT_'\na\nBROODS_INPUT\nb\nBROODS_INPUT_",
        },
      },
    ]);
    expect(tools.bash).toBeDefined();
  });

  it("asks for a command on a custom tool", async () => {
    await expect(
      build("openai", openai, {
        write_sql: descriptor(openai.tools.customTool({})),
      }),
    ).rejects.toThrow(/needs `command`/);
  });

  it("judges a stand-in call as the sandbox call it makes", async () => {
    const { createRuntimeToolApproval } =
      await import("../src/harness/policy.ts");
    const seen: unknown[] = [];
    const standIns = new Map();
    const tools = await build(
      "anthropic",
      anthropic,
      { shell: descriptor(anthropic.tools.bash_20250124({})) },
      standIns,
    );
    const { approval } = createRuntimeToolApproval({
      configuredApprovals: new Map([["shell", true]]),
      workspaces: [],
      sandboxes: [
        {
          name: "box",
          sandbox: { provider: "lambda", permissionMode: "bypass" },
        },
      ] as never,
      sandboxStandIns: standIns,
      policyApproval: async (event): Promise<undefined> => {
        seen.push(event.toolCall);

        return undefined;
      },
    });

    expect(
      await approval!({
        toolCall: {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "shell",
          input: { command: "rm -rf x" },
        },
        tools: tools,
        messages: [],
      } as never),
    ).toBe("user-approval");
    expect(seen).toMatchObject([
      { toolName: "bash", input: { command: "rm -rf x" } },
    ]);
  });
});

describe("fileOperationScript", () => {
  it("creates, updates, inserts into and deletes files", async () => {
    const { fileOperationScript } =
      await import("../src/harness/tools/file-operation.ts");
    const dir = mkdtempSync(join(tmpdir(), "apply-patch-"));
    const apply = (
      operation: Parameters<typeof fileOperationScript>[0],
    ): void => {
      const result = Bun.spawnSync(["bash", "-s"], {
        cwd: dir,
        stdin: Buffer.from(fileOperationScript(operation)),
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    };
    try {
      apply({
        type: "create_file",
        path: "src/a.py",
        diff: "+def f():\n+    return 1\n",
      });
      expect(readFileSync(join(dir, "src/a.py"), "utf8")).toBe(
        "def f():\n    return 1\n",
      );
      apply({
        type: "update_file",
        path: "src/a.py",
        diff: "@@ def f():\n-    return 1\n+    return 2\n",
      });
      expect(readFileSync(join(dir, "src/a.py"), "utf8")).toBe(
        "def f():\n    return 2\n",
      );
      writeFileSync(join(dir, "b.txt"), "one\ntwo\nthree\n");
      expect(() =>
        apply({ type: "update_file", path: "b.txt", diff: "-four\n+4\n" }),
      ).toThrow(/patch does not match/);
      apply({ type: "update_file", path: "b.txt", diff: "+four\n" });
      expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe(
        "one\ntwo\nthree\nfour\n",
      );
      apply({
        type: "create_file",
        path: "big.txt",
        diff: `+${"x".repeat(200_000)}\n`,
      });
      expect(readFileSync(join(dir, "big.txt"), "utf8").length).toBe(200_001);
      writeFileSync(join(dir, "b.txt"), "one\ntwo\nthree\n");
      apply({ type: "insert", path: "b.txt", line: 0, text: "zero" });
      apply({ type: "insert", path: "b.txt", line: 2, text: "1.5\n" });
      expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe(
        "zero\none\n1.5\ntwo\nthree\n",
      );
      expect(() =>
        apply({ type: "insert", path: "b.txt", line: 9, text: "x" }),
      ).toThrow(/insert_line 9 is outside 0\.\.5/);
      apply({ type: "delete_file", path: "b.txt" });
      expect(() => readFileSync(join(dir, "b.txt"))).toThrow();
      expect(() =>
        fileOperationScript({ type: "delete_file", path: "../x" }),
      ).toThrow(/traversal/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// As the CLI syncs it: JSON drops the lazy schemas and keeps type, id and args.
function descriptor(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}

async function build(
  modelProviderName: ToolContext["modelProviderName"],
  modelProvider: unknown,
  tools: Record<string, Record<string, unknown>>,
  sandboxStandIns: ToolContext["sandboxStandIns"] = new Map(),
  denyTools?: string[],
  extraWorkspaces: string[] = [],
): Promise<ToolSet> {
  calls.length = 0;
  const { createTools } = await import("../src/harness/tools/index.ts");
  const workspace = workspaceNamed("repo");
  const sandboxes = [{ name: "box", sandbox: workspace.sandbox! }];

  return await createTools(
    {
      accountId: "acct_test",
      conversationKey: "conversation",
      modelProviderName: modelProviderName,
      modelProvider: modelProvider,
      sandboxes: sandboxes,
      workspaces: [workspace, ...extraWorkspaces.map(workspaceNamed)],
      sandboxStandIns: sandboxStandIns,
    },
    { tools: tools, ...(denyTools ? { denyTools: denyTools } : {}) },
  );
}

// Inherits the agent's sandbox, so Broods tools offer no workspace or sandbox choice.
function workspaceNamed(name: string): ResolvedWorkspace {
  return {
    name: name,
    workspaceId: `ws_${name}`,
    namespace: "ns",
    config: { storage: { provider: "s3" } },
    sandbox: {
      provider: "lambda",
      permissionMode: "bypass",
      controlPlane: {
        accountId: "acct_test",
        name: "box",
        sandboxConfigId: "sbx_box",
        specs: { vcpu: 1, memoryMb: 512, storageGb: 1 },
      },
    },
  };
}

async function run(
  entry: ToolSet[string] | undefined,
  input: unknown,
): Promise<unknown> {
  return await entry!.execute!(input as never, {
    toolCallId: "call",
    messages: [],
    context: {},
  });
}
