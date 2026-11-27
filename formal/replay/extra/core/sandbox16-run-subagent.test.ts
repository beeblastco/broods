import { describe, expect, test } from "bun:test";

import runSubagentTool, {
  type RunSubagentDispatchResult,
  type RunSubagentTaskInput,
} from "../../../../apps/core/src/harness/tools/run-subagent.tool.ts";

const DISPATCHED: RunSubagentDispatchResult = { tasks: [] };

function run(
  input: object,
  mode?: "ephemeral" | "persistent",
): Promise<{ result: unknown; seen: RunSubagentTaskInput[][] }> {
  const seen: RunSubagentTaskInput[][] = [];
  const tools = runSubagentTool({
    mode: mode,
    dispatchSubagents: async (
      tasks: RunSubagentTaskInput[],
    ): Promise<RunSubagentDispatchResult> => {
      seen.push(tasks);

      return DISPATCHED;
    },
  });

  return Promise.resolve(
    tools.run_subagent?.execute?.(input, {
      toolCallId: "call_1",
      messages: [],
    }),
  ).then((result): { result: unknown; seen: RunSubagentTaskInput[][] } => ({
    result: result,
    seen: seen,
  }));
}

describe("normalizeInput", (): void => {
  test("tasks must be an array", async (): Promise<void> => {
    await expect(run({ tasks: "go" })).rejects.toThrow(
      "tasks must be a non-empty array",
    );
    await expect(run({})).rejects.toThrow("tasks must be a non-empty array");
  });

  test("tasks cannot be empty", async (): Promise<void> => {
    await expect(run({ tasks: [] })).rejects.toThrow(
      "tasks must include at least one subagent task",
    );
  });

  test("tasks are capped at ten", async (): Promise<void> => {
    await expect(
      run({
        tasks: Array.from({ length: 11 }, (): { prompt: string } => ({
          prompt: "p",
        })),
      }),
    ).rejects.toThrow("tasks must include at most 10 subagent tasks");
  });

  test("valid tasks are trimmed and dispatched", async (): Promise<void> => {
    const { seen } = await run({
      tasks: [{ prompt: " go ", agentId: " a1 ", isolated: true }],
    });

    expect(seen).toEqual([[{ agentId: "a1", prompt: "go", isolated: true }]]);
  });
});

describe("normalizeTask", (): void => {
  test("a task must be an object", async (): Promise<void> => {
    await expect(run({ tasks: ["go"] })).rejects.toThrow(
      "tasks[0] must be an object",
    );
  });

  test("isolated must be a boolean", async (): Promise<void> => {
    await expect(
      run({ tasks: [{ prompt: "p", isolated: "yes" }] }),
    ).rejects.toThrow("tasks[0].isolated must be a boolean");
  });
});

describe("normalizeRequiredString", (): void => {
  test("a blank prompt is refused", async (): Promise<void> => {
    await expect(run({ tasks: [{ prompt: "  " }] })).rejects.toThrow(
      "tasks[0].prompt must be a non-empty string",
    );
  });
});

describe("normalizeOptionalString", (): void => {
  test("an agent id must be a string", async (): Promise<void> => {
    await expect(run({ tasks: [{ prompt: "p", agentId: 3 }] })).rejects.toThrow(
      "tasks[0].agentId must be a string",
    );
  });
});
