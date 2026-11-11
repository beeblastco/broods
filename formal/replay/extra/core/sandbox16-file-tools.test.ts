import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ToolSet } from "ai";

import type { SandboxRunResult } from "../../../../apps/core/src/harness/sandbox/types.ts";
import bashTool from "../../../../apps/core/src/harness/tools/bash.tool.ts";
import editTool from "../../../../apps/core/src/harness/tools/edit.tool.ts";
import * as filesystemUtils from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import type { SandboxToolContext } from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import globTool from "../../../../apps/core/src/harness/tools/glob.tool.ts";
import grepTool from "../../../../apps/core/src/harness/tools/grep.tool.ts";
import readTool from "../../../../apps/core/src/harness/tools/read.tool.ts";
import writeTool from "../../../../apps/core/src/harness/tools/write.tool.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

type Spy = { mockRestore: () => void };
type Maker = (context: SandboxToolContext) => ToolSet;

const LAMBDA = { provider: "lambda" } as const;
const WORKER = { provider: "worker" } as const;

let spies: Spy[] = [];
let scripts: string[] = [];

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  scripts = [];
});

function workspace(
  overrides: Partial<ResolvedWorkspace> = {},
): ResolvedWorkspace {
  return {
    name: "notes",
    workspaceId: "ws_1",
    namespace: "fs-1",
    config: { storage: { provider: "s3" } },
    sandbox: LAMBDA,
    ...overrides,
  };
}

function ran(overrides: Partial<SandboxRunResult>): SandboxRunResult {
  return {
    ok: true,
    runtime: "bash",
    exitCode: 0,
    stdout: "",
    stderr: "",
    durationMs: 1,
    provider: "lambda",
    ...overrides,
  };
}

function sandboxAnswers(...answers: SandboxRunResult[]): void {
  const queue = [...answers];
  spies.push(
    spyOn(filesystemUtils, "runSandbox").mockImplementation(
      async (
        _config: unknown,
        _namespace: unknown,
        code: string,
      ): Promise<SandboxRunResult> => {
        scripts.push(code);

        return queue.shift() ?? ran({});
      },
    ),
  );
}

async function call(
  make: Maker,
  name: string,
  workspaces: ResolvedWorkspace[],
  input: object,
): Promise<unknown> {
  const tool = make({ workspaces: workspaces })[name];

  return await tool?.execute?.(input, { toolCallId: "call_1", messages: [] });
}

describe("readTool execute", (): void => {
  const read = (
    workspaces: ResolvedWorkspace[],
    input: object,
  ): Promise<unknown> => call(readTool, "read", workspaces, input);

  test("no workspace is an error", async (): Promise<void> => {
    await expect(read([], { file_path: "a.txt" })).rejects.toThrow(
      "no workspace attached",
    );
  });

  test("a workspace with no sandbox reads from storage", async (): Promise<void> => {
    spies.push(
      spyOn(filesystemUtils, "s3ReadNumbered").mockResolvedValue("1\thello"),
    );

    expect(
      await read([workspace({ sandbox: undefined })], { file_path: "a.txt" }),
    ).toBe("1\thello");
  });

  test("a sandbox read pages with offset and limit", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "3\tc\n" }));

    expect(
      await read([workspace()], { file_path: "/a.txt", offset: 3, limit: 1 }),
    ).toBe("3\tc\n");
    expect(scripts[0]).toContain("sed -n '3,3p'");
  });

  test("a failed read reports the shell's words", async (): Promise<void> => {
    sandboxAnswers(
      ran({ ok: false, stderr: "Error: file not found: a.txt\n" }),
    );

    await expect(read([workspace()], { file_path: "a.txt" })).rejects.toThrow(
      "Error: file not found: a.txt",
    );
  });

  test("a failed read with no output says the read failed", async (): Promise<void> => {
    sandboxAnswers(ran({ ok: false }));

    await expect(read([workspace()], { file_path: "a.txt" })).rejects.toThrow(
      "Error: read failed",
    );
  });

  test("a read-only workspace reads through its mount", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "1\tx\n" }));

    expect(
      await read([workspace({ sandbox: undefined, readMount: LAMBDA })], {
        file_path: "a.txt",
      }),
    ).toBe("1\tx\n");
  });
});

describe("globTool execute", (): void => {
  const glob = (
    workspaces: ResolvedWorkspace[],
    input: object,
  ): Promise<unknown> => call(globTool, "glob", workspaces, input);

  test("a blank pattern is refused", async (): Promise<void> => {
    await expect(glob([workspace()], { pattern: " " })).rejects.toThrow(
      "pattern is required",
    );
  });

  test("no workspace is an error", async (): Promise<void> => {
    await expect(glob([], { pattern: "*.ts" })).rejects.toThrow(
      "no workspace attached",
    );
  });

  test("a workspace with no sandbox globs in storage", async (): Promise<void> => {
    spies.push(spyOn(filesystemUtils, "s3Glob").mockResolvedValue("a.ts\n"));

    expect(
      await glob([workspace({ sandbox: undefined })], { pattern: "*.ts" }),
    ).toBe("a.ts\n");
  });

  test("a sandbox glob returns the script's list", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "a.ts\n" }));

    expect(await glob([workspace()], { pattern: "*.ts", path: "src" })).toBe(
      "a.ts\n",
    );
  });

  test("a failed sandbox glob reports the shell's words", async (): Promise<void> => {
    sandboxAnswers(ran({ ok: false }));

    await expect(glob([workspace()], { pattern: "*.ts" })).rejects.toThrow(
      "Error: glob failed",
    );
  });

  test("a shell-only sandbox filters the listing in core", async (): Promise<void> => {
    sandboxAnswers(
      ran({ stdout: "./b.ts\n./a.ts\n./c.md\n\n", truncated: true }),
    );

    expect(
      await glob([workspace({ sandbox: WORKER })], { pattern: "*.ts" }),
    ).toBe(
      "a.ts\nb.ts\n(listing cut at the sandbox's output limit; narrow the path)\n",
    );
  });

  test("a shell-only sandbox with no match says so", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "./c.md\n" }));

    expect(
      await glob([workspace({ sandbox: WORKER })], { pattern: "*.ts" }),
    ).toBe("No files found\n");
  });

  test("a failed shell-only listing is an error", async (): Promise<void> => {
    sandboxAnswers(ran({ ok: false, stderr: "no such directory" }));

    await expect(
      glob([workspace({ sandbox: WORKER })], { pattern: "*.ts" }),
    ).rejects.toThrow("no such directory");
  });
});

describe("grepTool execute", (): void => {
  const grep = (
    workspaces: ResolvedWorkspace[],
    input: object,
  ): Promise<unknown> => call(grepTool, "grep", workspaces, input);

  test("an empty pattern is refused", async (): Promise<void> => {
    await expect(grep([workspace()], { pattern: "" })).rejects.toThrow(
      "pattern is required",
    );
  });

  test("a read-only workspace cannot be searched", async (): Promise<void> => {
    await expect(
      grep([workspace({ sandbox: undefined })], { pattern: "x" }),
    ).rejects.toThrow("workspace is read-only");
  });

  test("exit 1 is no match and keeps the stderr note", async (): Promise<void> => {
    sandboxAnswers(ran({ ok: false, exitCode: 1, stderr: "regex note\n" }));

    expect(await grep([workspace()], { pattern: "x" })).toBe(
      "No matches found\nregex note",
    );
  });

  test("another failure reports the shell's words", async (): Promise<void> => {
    sandboxAnswers(ran({ ok: false, exitCode: 2 }));

    await expect(grep([workspace()], { pattern: "x" })).rejects.toThrow(
      "Error: grep failed",
    );
  });

  test("counts drop files with no match", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "a.ts:2\nb.ts:0\n" }));

    expect(
      await grep([workspace()], { pattern: "x", output_mode: "count" }),
    ).toBe("a.ts:2");
  });

  test("empty output says no matches", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "  \n" }));

    expect(await grep([workspace()], { pattern: "x" })).toBe(
      "No matches found",
    );
  });
});

describe("writeTool execute", (): void => {
  const write = (
    workspaces: ResolvedWorkspace[],
    input: object,
  ): Promise<unknown> => call(writeTool, "write", workspaces, input);

  test("a read-only workspace cannot be written", async (): Promise<void> => {
    await expect(
      write([workspace({ sandbox: undefined })], {
        file_path: "a",
        content: "",
      }),
    ).rejects.toThrow("workspace is read-only");
  });

  test("the root is not a file", async (): Promise<void> => {
    await expect(
      write([workspace()], { file_path: "/", content: "" }),
    ).rejects.toThrow("file_path must reference a file");
  });

  test("a write syncs on a mounted sandbox and reports the bytes", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "Wrote a.txt (2 bytes)\n" }));

    expect(
      await write([workspace()], { file_path: "a.txt", content: "hi" }),
    ).toBe("Wrote a.txt (2 bytes)");
    expect(scripts[0]).toContain("sync 'a.txt'");
  });

  test("a shell-only sandbox skips the sync", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "Wrote a.txt (0 bytes)\n" }));

    await write([workspace({ sandbox: WORKER })], { file_path: "a.txt" });

    expect(scripts[0]).not.toContain("sync");
  });

  test("a failed write reports the shell's words", async (): Promise<void> => {
    sandboxAnswers(ran({ ok: false }));

    await expect(
      write([workspace()], { file_path: "a.txt", content: "hi" }),
    ).rejects.toThrow("Error: write failed");
  });
});

describe("editTool execute", (): void => {
  const edit = (
    workspaces: ResolvedWorkspace[],
    input: object,
  ): Promise<unknown> => call(editTool, "edit", workspaces, input);
  const change = { old_string: "a", new_string: "b" };

  test("a read-only workspace cannot be edited", async (): Promise<void> => {
    await expect(
      edit([workspace({ sandbox: undefined })], {
        file_path: "a.ts",
        ...change,
      }),
    ).rejects.toThrow("workspace is read-only");
  });

  test("the root is not a file", async (): Promise<void> => {
    await expect(
      edit([workspace()], { file_path: ".", ...change }),
    ).rejects.toThrow("file_path must reference a file");
  });

  test("the sandbox's script answer is returned", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "Edited a.ts (1 replacement)\n" }));

    expect(await edit([workspace()], { file_path: "a.ts", ...change })).toBe(
      "Edited a.ts (1 replacement)",
    );
  });

  test("a failed script reports the shell's words", async (): Promise<void> => {
    sandboxAnswers(
      ran({ ok: false, stderr: "Error: old_string not found in a.ts" }),
    );

    await expect(
      edit([workspace()], { file_path: "a.ts", ...change }),
    ).rejects.toThrow("old_string not found");
    sandboxAnswers(ran({ ok: false }));
    await expect(
      edit([workspace()], { file_path: "a.ts", ...change }),
    ).rejects.toThrow("Error: edit failed");
  });
});

describe("bashTool execute", (): void => {
  const bash = (
    workspaces: ResolvedWorkspace[],
    input: object,
  ): Promise<unknown> => call(bashTool, "bash", workspaces, input);

  test("an empty command is refused", async (): Promise<void> => {
    await expect(bash([workspace()], { command: "  " })).rejects.toThrow(
      "command is required",
    );
  });

  test("a sandbox choice must be a name", async (): Promise<void> => {
    await expect(
      bash([workspace()], { command: "ls", sandbox: 3 }),
    ).rejects.toThrow("sandbox must be the name of a sandbox");
  });

  test("a command with nowhere to run is an error", async (): Promise<void> => {
    await expect(bash([], { command: "ls" })).rejects.toThrow(
      "no sandbox available for this command",
    );
  });

  test("parent traversal is refused", async (): Promise<void> => {
    await expect(bash([workspace()], { command: "cat ../x" })).rejects.toThrow(
      "parent directory traversal is not allowed",
    );
  });

  test("a runtime the sandbox excludes is refused", async (): Promise<void> => {
    const python = workspace({
      sandbox: { provider: "lambda", runtimes: ["bash"] },
    });

    await expect(bash([python], { command: "python3 x.py" })).rejects.toThrow(
      "does not allow python commands",
    );
  });

  test("a pty command runs wrapped in script", async (): Promise<void> => {
    sandboxAnswers(ran({ stdout: "ok\n" }));

    expect(await bash([workspace()], { command: "ls", pty: true })).toBe(
      "ok\n",
    );
    expect(scripts[0]).toBe("script -qec 'ls' /dev/null");
  });

  test("a background job needs a persistent sandbox", async (): Promise<void> => {
    await expect(
      bash([workspace()], { command: "sleep 9", background: true }),
    ).rejects.toThrow("background jobs require a persistent workspace sandbox");
  });
});
