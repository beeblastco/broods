import { afterEach, describe, expect, spyOn, test } from "bun:test";

import editTool from "../../../../apps/core/src/harness/tools/edit.tool.ts";
import * as filesystemUtils from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import type { SandboxToolContext } from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import type { SandboxRunResult } from "../../../../apps/core/src/harness/sandbox/types.ts";

type RunSpy = ReturnType<typeof spyOn<typeof filesystemUtils, "runSandbox">>;

const CONTEXT = {
  workspaces: [
    {
      name: "project",
      workspaceId: "ws_a",
      namespace: "fs-test",
      config: { storage: { provider: "disk" } },
      sandbox: { provider: "worker", network: { mode: "deny-all" } },
    },
  ],
} as unknown as SandboxToolContext;

let spy: RunSpy | undefined;

afterEach((): void => {
  spy?.mockRestore();
});

function result(overrides: Partial<SandboxRunResult>): SandboxRunResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    truncated: false,
    ...overrides,
  } as SandboxRunResult;
}

function file(text: string): SandboxRunResult {
  return result({ stdout: `${Buffer.from(text).toString("base64")}\n` });
}

async function edit(
  runs: SandboxRunResult[],
  input: { old_string: string; new_string: string; replace_all?: boolean },
): Promise<unknown> {
  const queue = [...runs];
  spy = spyOn(filesystemUtils, "runSandbox").mockImplementation(
    async (): Promise<SandboxRunResult> => queue.shift() ?? result({}),
  );

  return await editTool(CONTEXT).edit?.execute?.(
    { file_path: "a.ts", ...input },
    { toolCallId: "call_1", messages: [] },
  );
}

describe("editOnShell", (): void => {
  test("an empty old_string is refused", async (): Promise<void> => {
    await expect(edit([], { old_string: "", new_string: "x" })).rejects.toThrow(
      "old_string must not be empty",
    );
  });

  test("an unchanged string is refused", async (): Promise<void> => {
    await expect(
      edit([], { old_string: "same", new_string: "same" }),
    ).rejects.toThrow("old_string and new_string are identical");
  });

  test("a failed read reports the shell's words", async (): Promise<void> => {
    await expect(
      edit([result({ ok: false, stderr: "Error: file not found: a.ts" })], {
        old_string: "a",
        new_string: "b",
      }),
    ).rejects.toThrow("Error: file not found: a.ts");
  });

  test("a failed read with no output says the edit failed", async (): Promise<void> => {
    await expect(
      edit([result({ ok: false })], { old_string: "a", new_string: "b" }),
    ).rejects.toThrow("Error: edit failed");
  });

  test("a cut read is not written back", async (): Promise<void> => {
    await expect(
      edit([result({ stdout: "YQ==", truncated: true })], {
        old_string: "a",
        new_string: "b",
      }),
    ).rejects.toThrow("is too large to edit here");
  });

  test("a missing old_string is refused", async (): Promise<void> => {
    await expect(
      edit([file("one two")], { old_string: "three", new_string: "b" }),
    ).rejects.toThrow("old_string not found in a.ts");
  });

  test("a repeated old_string needs replace_all", async (): Promise<void> => {
    await expect(
      edit([file("x x")], { old_string: "x", new_string: "y" }),
    ).rejects.toThrow("not unique (2 matches)");
  });

  test("replace_all rewrites every match", async (): Promise<void> => {
    expect(
      await edit([file("x x"), result({})], {
        old_string: "x",
        new_string: "y",
        replace_all: true,
      }),
    ).toBe("Edited a.ts (2 replacements)");
  });

  test("a failed write reports the shell's words", async (): Promise<void> => {
    await expect(
      edit([file("x"), result({ ok: false, stdout: "disk full" })], {
        old_string: "x",
        new_string: "y",
      }),
    ).rejects.toThrow("disk full");
  });
});
