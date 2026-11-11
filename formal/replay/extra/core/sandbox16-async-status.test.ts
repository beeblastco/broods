import { afterEach, describe, expect, spyOn, test } from "bun:test";

import type { AsyncToolResultRecord } from "../../../../apps/core/src/harness/async-tool-result.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import * as sandboxIndex from "../../../../apps/core/src/harness/sandbox/index.ts";
import type {
  SandboxExecutor,
  SandboxJobLogs,
  SandboxJobStatus,
} from "../../../../apps/core/src/harness/sandbox/types.ts";
import asyncStatusTool from "../../../../apps/core/src/harness/tools/async-status.tool.ts";
import type { ResolvedWorkspace } from "../../../../apps/core/src/shared/workspaces.ts";

type Spy = { mockRestore: () => void };

const CONVERSATION = "conv_1";
const WORKSPACE: ResolvedWorkspace = {
  name: "notes",
  workspaceId: "ws_1",
  namespace: "fs-1",
  config: { storage: { provider: "s3" } },
  sandbox: { provider: "sandbox", persistent: true },
};
const JOB_INPUT = { kind: "sandbox_job", namespace: "fs-1", jobId: "job_1" };

let spies: Spy[] = [];
let handed: string[] = [];
let mutate: ReturnType<typeof spyOn<typeof runtime, "mutate">>;

afterEach((): void => {
  for (const spy of spies) spy.mockRestore();
  spies = [];
  handed = [];
});

function record(
  overrides: Partial<AsyncToolResultRecord>,
): AsyncToolResultRecord {
  return {
    resultId: "res_1",
    parentEventId: "evt_1",
    conversationKey: CONVERSATION,
    toolName: "bash",
    toolCallId: "call_0",
    input: JOB_INPUT,
    status: "processing",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: 0,
    ...overrides,
  };
}

function executorWith(parts: Partial<SandboxExecutor>): SandboxExecutor {
  return parts as SandboxExecutor;
}

async function status(
  stored: AsyncToolResultRecord | null,
  executor: SandboxExecutor | undefined,
  action?: "status" | "logs" | "stop",
  workspaces: ResolvedWorkspace[] = [WORKSPACE],
): Promise<unknown> {
  mutate = spyOn(runtime, "mutate").mockResolvedValue(null);
  spies.push(spyOn(runtime, "query").mockResolvedValue(stored), mutate);
  if (executor) {
    spies.push(
      spyOn(sandboxIndex, "createSandboxExecutor").mockReturnValue(executor),
    );
  }
  const tools = asyncStatusTool({
    conversationKey: CONVERSATION,
    workspaces: workspaces,
    supportsJobs: true,
    onResultRead: (_toolCallId: string, resultId: string): void => {
      handed.push(resultId);
    },
  });

  return await tools.async_status?.execute?.(
    { statusId: "res_1", ...(action ? { action: action } : {}) },
    { toolCallId: "call_1", messages: [] },
  );
}

function jobStatus(
  state: SandboxJobStatus["state"],
  exitCode?: number,
): Pick<SandboxExecutor, "jobStatus"> {
  return {
    jobStatus: async (): Promise<SandboxJobStatus> => ({
      jobId: "job_1",
      state: state,
      ...(exitCode === undefined ? {} : { exitCode: exitCode }),
    }),
  };
}

function logsOf(logs: string): Pick<SandboxExecutor, "jobLogs"> {
  return {
    jobLogs: async (): Promise<SandboxJobLogs> => ({
      jobId: "job_1",
      logs: logs,
      truncated: false,
    }),
  };
}

describe("asyncStatusTool", (): void => {
  test("an unknown or foreign result is not found", async (): Promise<void> => {
    await expect(status(null, undefined)).rejects.toThrow(
      "no async result found for res_1",
    );
    await expect(
      status(record({ conversationKey: "other" }), undefined),
    ).rejects.toThrow("no async result found for res_1");
  });

  test("a settled result is reported and handed over", async (): Promise<void> => {
    expect(
      await status(
        record({ status: "completed", response: { logs: "line" } }),
        undefined,
      ),
    ).toEqual({ status: "completed", response: { logs: "line" } });
    expect(
      await status(record({ status: "failed", error: "boom" }), undefined),
    ).toEqual({ status: "failed", error: "boom" });
    expect(handed).toEqual(["res_1", "res_1"]);
  });

  test("logs of a settled job come back as text", async (): Promise<void> => {
    expect(
      await status(
        record({ status: "completed", response: { logs: "line" } }),
        undefined,
        "logs",
      ),
    ).toBe("line");
    expect(
      await status(
        record({ status: "completed", response: { logs: "" } }),
        undefined,
        "logs",
      ),
    ).toBe("(no output)");
  });

  test("a result that is not a sandbox job is delivered automatically", async (): Promise<void> => {
    expect(
      await status(record({ input: { kind: "other" } }), undefined),
    ).toEqual({ status: "processing", delivery: "automatic" });
  });

  test("a job whose workspace is gone has no sandbox to ask", async (): Promise<void> => {
    await expect(status(record({}), undefined, "status", [])).rejects.toThrow(
      "no sandbox available to inspect job job_1",
    );
  });

  test("logs of a running job are tailed", async (): Promise<void> => {
    expect(await status(record({}), executorWith(logsOf("out")), "logs")).toBe(
      "out",
    );
    expect(await status(record({}), executorWith(logsOf("")), "logs")).toBe(
      "(no output yet)",
    );
  });

  test("an executor without logs or stop says so", async (): Promise<void> => {
    await expect(status(record({}), executorWith({}), "logs")).rejects.toThrow(
      "does not support job logs",
    );
    await expect(status(record({}), executorWith({}), "stop")).rejects.toThrow(
      "does not support stopping jobs",
    );
  });

  test("an executor without live status reports it unsupported", async (): Promise<void> => {
    expect(await status(record({}), executorWith({}))).toEqual({
      status: "processing",
      jobId: "job_1",
      liveStatus: "unsupported",
      delivery: "automatic",
    });
  });

  test("a running or unknown job is reported as such", async (): Promise<void> => {
    expect(
      await status(record({}), executorWith(jobStatus("running"))),
    ).toEqual({ status: "processing", jobId: "job_1" });
    expect(
      await status(record({}), executorWith(jobStatus("unknown"))),
    ).toEqual({ status: "unknown", jobId: "job_1" });
  });

  test("a finished job is settled with its logs", async (): Promise<void> => {
    expect(
      await status(
        record({}),
        executorWith({ ...jobStatus("completed", 0), ...logsOf("done") }),
      ),
    ).toEqual({
      status: "completed",
      jobId: "job_1",
      exitCode: 0,
      logs: "done",
    });
    expect(mutate).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: "res_1",
      status: "completed",
      response: { state: "completed", exitCode: 0, logs: "done" },
      onlyWhenProcessing: true,
    });
    expect(handed).toEqual(["res_1"]);
  });

  test("a failed job is settled with its exit code and logs", async (): Promise<void> => {
    await status(
      record({}),
      executorWith({ ...jobStatus("failed", 2), ...logsOf("trace") }),
    );
    expect(mutate).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: "res_1",
      status: "failed",
      error: "Job exited with code 2.\ntrace",
      onlyWhenProcessing: true,
    });
  });

  test("a failed job without a code or logs is still settled", async (): Promise<void> => {
    await status(record({}), executorWith(jobStatus("failed")));
    expect(mutate).toHaveBeenCalledWith("updateAsyncToolResult", {
      resultId: "res_1",
      status: "failed",
      error: "Job exited with code unknown.",
      onlyWhenProcessing: true,
    });
  });

  test("stopping a job settles it", async (): Promise<void> => {
    const result = await status(
      record({}),
      executorWith({
        stopJob: async (): Promise<SandboxJobStatus> => ({
          jobId: "job_1",
          state: "failed",
          exitCode: 137,
        }),
        ...logsOf("killed"),
      }),
      "stop",
    );

    expect(result).toEqual({
      status: "failed",
      jobId: "job_1",
      exitCode: 137,
      logs: "killed",
    });
    expect(handed).toEqual(["res_1"]);
  });

  test("an executor failure becomes the tool's error", async (): Promise<void> => {
    await expect(
      status(
        record({}),
        executorWith({
          jobStatus: async (): Promise<SandboxJobStatus> => {
            throw new Error("sandbox unreachable");
          },
        }),
      ),
    ).rejects.toThrow("sandbox unreachable");
  });
});
