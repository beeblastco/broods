import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { SandboxRunResult } from "../../../../apps/core/src/harness/sandbox/types.ts";
import * as filesystemUtils from "../../../../apps/core/src/harness/tools/filesystem-utils.ts";
import memoryTool, {
  type MemoryToolContext,
} from "../../../../apps/core/src/harness/tools/memory.tool.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

type Spy = { mockRestore: () => void };

const CONVERSATION = "acct:acct_1:agent:a1:slack:T1:C1:171.0";

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
    sandbox: { provider: "lambda" },
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

function save(
  input: object,
  answer: SandboxRunResult = ran({ stdout: "Saved memory\n" }),
  target: ResolvedWorkspace = workspace(),
): Promise<unknown> {
  spies.push(
    spyOn(filesystemUtils, "runSandbox").mockImplementation(
      async (
        _config: unknown,
        _namespace: unknown,
        code: string,
      ): Promise<SandboxRunResult> => {
        scripts.push(code);

        return answer;
      },
    ),
  );
  const context: MemoryToolContext = {
    workspaces: [target],
    conversationKey: CONVERSATION,
  };

  return Promise.resolve(
    memoryTool(context).memory_save?.execute?.(input, {
      toolCallId: "call_1",
      messages: [],
    }),
  );
}

const FACT = { title: "Team Lead", description: "Ana leads it", content: "x" };

describe("memoryTool execute", (): void => {
  test("a read-only workspace cannot remember", async (): Promise<void> => {
    await expect(
      save(FACT, undefined, workspace({ sandbox: undefined })),
    ).rejects.toThrow("workspace is read-only");
  });

  test("a workspace with the memory harness off is refused", async (): Promise<void> => {
    await expect(
      save(
        FACT,
        undefined,
        workspace({
          config: {
            storage: { provider: "s3" },
            harness: { memory: { enabled: false } },
          },
        }),
      ),
    ).rejects.toThrow("memory harness is disabled for workspace notes");
  });

  test("a title that is only brackets is empty", async (): Promise<void> => {
    await expect(save({ ...FACT, title: " [ ] " })).rejects.toThrow(
      "title must not be empty",
    );
  });

  test("a blank description is refused", async (): Promise<void> => {
    await expect(save({ ...FACT, description: "  " })).rejects.toThrow(
      "description must not be empty",
    );
  });

  test("an entry is saved with its type and origin", async (): Promise<void> => {
    expect(await save({ ...FACT, type: "user" })).toBe("Saved memory");
    expect(scripts[0]).toContain("memory/team-lead.md");
  });

  test("an unknown type is saved as a project memory", async (): Promise<void> => {
    await save({ ...FACT, type: "other" });

    const encoded = /printf '%s' '([^']+)' \| base64 -d/.exec(scripts[0] ?? "");
    const entry = Buffer.from(encoded?.[1] ?? "", "base64").toString("utf8");

    expect(entry).toContain("  type: project");
  });

  test("a failed save reports the shell's words", async (): Promise<void> => {
    await expect(save(FACT, ran({ ok: false }))).rejects.toThrow(
      "Error: memory save failed",
    );
  });
});
