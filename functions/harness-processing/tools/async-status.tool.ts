/**
 * async_status — model-facing tool to check, tail, or stop a background job /
 * async tool call by its resultId.
 *
 * Auto-registered (see tools/index.ts) when the agent has any async tool or a
 * persistent sandbox. Reads the AsyncToolResult row, and for a detached sandbox
 * job rebuilds the workspace's executor to poll status / tail logs / stop it,
 * settling the row when the job finishes. Background jobs also deliver themselves
 * automatically (sandbox callback), so polling is optional — it just lets the
 * model see progress or a result sooner.
 */

import { jsonSchema, tool, type ToolSet } from "ai";
import {
  getAsyncToolResult,
  markAsyncToolResultCompleted,
  markAsyncToolResultFailed,
} from "../async-tool-result.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import type { SandboxExecutor, SandboxExecutorConfig, SandboxJobStatus } from "../sandbox/types.ts";
import type { ResolvedWorkspace } from "../../_shared/workspaces.ts";
import { toolError, toolText } from "./filesystem-utils.ts";

const JOB_LOG_LIMIT_BYTES = 64 * 1024;

interface AsyncStatusInput {
  resultId: string;
  action?: "status" | "logs" | "stop";
}

interface SandboxJobRef {
  namespace: string;
  jobId: string;
}

export interface AsyncStatusContext {
  // The caller's conversation. A resultId only resolves for its own conversation,
  // so one agent cannot inspect or stop another tenant's job.
  conversationKey: string;
  workspaces?: ResolvedWorkspace[];
}

export default function asyncStatusTool(context: AsyncStatusContext): ToolSet {
  return {
    async_status: tool({
      description: `Check on a background job or async tool call by its resultId.

Usage notes:
- Pass the resultId returned when the job/tool started.
- action "status" (default): report whether it is running, completed, or failed (with exit code for sandbox jobs).
- action "logs": return the job's output so far (tail).
- action "stop": terminate a running sandbox job.
A completed/failed background job is also delivered back into the conversation automatically; polling here is optional and just surfaces progress or the result sooner.`,
      inputSchema: jsonSchema({
        type: "object",
        properties: {
          resultId: { type: "string", description: "The resultId returned when the background job/async tool started." },
          action: {
            type: "string",
            enum: ["status", "logs", "stop"],
            description: "status (default) | logs | stop.",
          },
        },
        required: ["resultId"],
        additionalProperties: false,
      }),
      async execute(input) {
        const { resultId, action = "status" } = input as AsyncStatusInput;
        const record = await getAsyncToolResult(resultId);
        // Resolve only within the caller's own conversation (both missing and
        // foreign rows return the same not-found, so it is not an oracle).
        if (!record || record.conversationKey !== context.conversationKey) {
          return toolError(`Error: no async result found for ${resultId}`);
        }
        if (record.status === "completed") {
          return toolText(`completed\n${formatUnknown(record.response)}`);
        }
        if (record.status === "failed") {
          return toolText(`failed\n${record.error ?? "(no error detail)"}`);
        }

        // Still processing. A sandbox-job row can be polled live; any other async
        // tool is delivered automatically when its in-flight work completes.
        const job = sandboxJobRef(record.input);
        if (!job) {
          return toolText("running — this result will be delivered automatically when it completes.");
        }

        const sandbox = sandboxForNamespace(context, job.namespace);
        if (!sandbox) {
          return toolError(`Error: no sandbox available to inspect job ${job.jobId}`);
        }
        const executor = createSandboxExecutor(sandbox);

        try {
          if (action === "logs") {
            if (!executor.jobLogs) return toolError("Error: this sandbox does not support job logs");
            const logs = await executor.jobLogs({ jobId: job.jobId, namespace: job.namespace, outputLimitBytes: JOB_LOG_LIMIT_BYTES });
            return toolText(logs.logs.length > 0 ? logs.logs : "(no output yet)");
          }
          if (action === "stop") {
            if (!executor.stopJob) return toolError("Error: this sandbox does not support stopping jobs");
            const stopped = await executor.stopJob({ jobId: job.jobId, namespace: job.namespace });
            return toolText(await settleTerminalJob(resultId, executor, job, stopped));
          }

          if (!executor.jobStatus) return toolError("Error: this sandbox does not support job status");
          const status = await executor.jobStatus({ jobId: job.jobId, namespace: job.namespace });
          if (status.state === "running") {
            return toolText(`running (job ${job.jobId})`);
          }
          if (status.state === "unknown") {
            return toolText(`unknown — no record of job ${job.jobId} in the sandbox`);
          }
          return toolText(await settleTerminalJob(resultId, executor, job, status));
        } catch (cause) {
          return toolError(cause instanceof Error ? cause.message : String(cause));
        }
      },
    }),
  };
}

// Settle the row with the job's real terminal state (a job that already finished
// keeps its own exit code rather than being recorded as killed) and return a
// human-readable summary including the captured logs.
async function settleTerminalJob(
  resultId: string,
  executor: SandboxExecutor,
  job: SandboxJobRef,
  status: SandboxJobStatus,
): Promise<string> {
  const logs = executor.jobLogs
    ? (await executor.jobLogs({ jobId: job.jobId, namespace: job.namespace, outputLimitBytes: JOB_LOG_LIMIT_BYTES })).logs
    : "";
  if (status.state === "completed") {
    await markAsyncToolResultCompleted({ resultId, response: { state: status.state, exitCode: status.exitCode ?? null, logs } });
  } else {
    await markAsyncToolResultFailed({ resultId, error: `Job exited with code ${status.exitCode ?? "unknown"}.${logs ? `\n${logs}` : ""}` });
  }
  return `${status.state} (exit ${status.exitCode ?? "unknown"})\n${logs}`;
}

function sandboxJobRef(input: unknown): SandboxJobRef | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (record.kind !== "sandbox_job" || typeof record.namespace !== "string" || typeof record.jobId !== "string") {
    return undefined;
  }
  return { namespace: record.namespace, jobId: record.jobId };
}

function sandboxForNamespace(context: AsyncStatusContext, namespace: string): SandboxExecutorConfig | undefined {
  return (context.workspaces ?? []).find((entry) => entry.namespace === namespace && entry.sandbox)?.sandbox;
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
