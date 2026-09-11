/**
 * async_status. The model-facing tool to check, tail, or stop a background job /
 * async tool call by its statusId.
 *
 * Auto-registered (see tools/index.ts) when the agent has any async tool or a
 * persistent sandbox. A detached sandbox job is polled through the workspace's
 * executor and its row settled here; background jobs also deliver themselves
 * through the sandbox callback, so polling only surfaces the result sooner.
 *
 * `statusId` carries the internal AsyncToolResult `resultId`, renamed at this
 * boundary. `logs`/`stop` exist only when the agent can launch background (bash)
 * jobs, so the description and the action enum are both built from
 * `supportsJobs` to keep the prompt from drifting.
 */

import { jsonSchema, tool, type JSONValue, type ToolSet } from "ai";
import type { ResolvedWorkspace } from "../../shared/workspaces.ts";
import {
  getAsyncToolResult,
  markAsyncToolResultCompleted,
  markAsyncToolResultFailed,
  markAsyncToolResultObserved,
} from "../async-tool-result.ts";
import { createSandboxExecutor } from "../sandbox/index.ts";
import type {
  SandboxExecutor,
  SandboxExecutorConfig,
  SandboxJobStatus,
} from "../sandbox/types.ts";
import { toolError } from "./utils.ts";

const JOB_LOG_LIMIT_BYTES = 64 * 1024;

export interface AsyncStatusContext {
  // The caller's conversation. A statusId only resolves for its own conversation,
  // so one agent cannot inspect or stop another tenant's job.
  conversationKey: string;
  workspaces?: ResolvedWorkspace[];
  // True only when the agent can launch background (bash) jobs. It gates the
  // `logs`/`stop` actions, which have no meaning for async tool calls (there is
  // no live process to tail or kill, and those are delivered automatically).
  supportsJobs: boolean;
}

interface AsyncStatusInput {
  statusId: string;
  action?: "status" | "logs" | "stop";
}

interface SandboxJobRef {
  namespace: string;
  jobId: string;
}

export default function asyncStatusTool(context: AsyncStatusContext): ToolSet {
  return {
    async_status: tool({
      description: context.supportsJobs
        ? `Check on a background job or async tool call by its statusId.

Usage notes:
- Pass the statusId returned when the job/tool started.
- action "status" (default): report whether it is running, completed, or failed (with exit code for background jobs).
- action "logs": tail a background (bash) job's output so far. Background jobs called from bash only, not applied for other tools.
- action "stop": terminate a running background (bash) job. Background jobs from bash only, not applied for other tools.
A completed/failed item is also delivered back into the conversation automatically; polling here is optional and just surfaces progress or the result.`
        : `Check on an async tool call by its statusId.

Usage notes:
- Pass the statusId returned when the async tool started.
- Reports whether it is running, completed, or failed.
The result is delivered back into the conversation automatically when it finishes; polling here is optional and just surfaces the result.`,
      inputSchema: jsonSchema<AsyncStatusInput>({
        type: "object",
        properties: {
          statusId: {
            type: "string",
            description:
              "The statusId returned when the background job/async tool started.",
          },
          ...(context.supportsJobs
            ? {
                action: {
                  type: "string",
                  enum: ["status", "logs", "stop"],
                  description:
                    "status (default) | logs (background jobs only) | stop (background jobs only).",
                },
              }
            : {}),
        },
        required: ["statusId"],
        additionalProperties: false,
      }),
      execute: async function (input): Promise<JSONValue> {
        const { statusId, action = "status" } = input;
        const record = await getAsyncToolResult(statusId);
        // Resolve only within the caller's own conversation (both missing and
        // foreign rows return the same not-found, so it is not an oracle).
        if (!record || record.conversationKey !== context.conversationKey) {
          return toolError(`Error: no async result found for ${statusId}`);
        }
        // The model is consuming the terminal result here, so mark it observed
        // (awaited, since the resume gate reads this row the moment the turn ends)
        // to stop the auto-delivery resume from injecting the same answer again.
        if (record.status === "completed") {
          await markAsyncToolResultObserved(statusId);
          // For a settled background job, `logs` returns just the captured output
          // (mirroring the live tail) instead of the whole settled record.
          const settledLogs =
            action === "logs" ? settledJobLogs(record.response) : undefined;
          if (settledLogs !== undefined) {
            return settledLogs.length > 0 ? settledLogs : "(no output)";
          }

          return {
            status: record.status,
            response: record.response ?? null,
          };
        }
        if (record.status === "failed") {
          await markAsyncToolResultObserved(statusId);

          return {
            status: record.status,
            error: record.error ?? null,
          };
        }

        // Still processing. A sandbox-job row can be polled live; any other async
        // tool is delivered automatically when its in-flight work completes.
        const job = sandboxJobRef(record.input);
        if (!job) {
          return {
            status: "processing",
            delivery: "automatic",
          };
        }

        const sandbox = sandboxForNamespace(context, job.namespace);
        if (!sandbox) {
          return toolError(
            `Error: no sandbox available to inspect job ${job.jobId}`,
          );
        }
        const executor = createSandboxExecutor(sandbox);

        try {
          if (action === "logs") {
            if (!executor.jobLogs)
              return toolError("Error: this sandbox does not support job logs");
            const logs = await executor.jobLogs({
              jobId: job.jobId,
              namespace: job.namespace,
              outputLimitBytes: JOB_LOG_LIMIT_BYTES,
            });

            return logs.logs.length > 0 ? logs.logs : "(no output yet)";
          }
          if (action === "stop") {
            if (!executor.stopJob)
              return toolError(
                "Error: this sandbox does not support stopping jobs",
              );
            const stopped = await executor.stopJob({
              jobId: job.jobId,
              namespace: job.namespace,
            });

            return settleTerminalJob(statusId, executor, job, stopped);
          }

          if (!executor.jobStatus) {
            return {
              status: "processing",
              jobId: job.jobId,
              liveStatus: "unsupported",
              delivery: "automatic",
            };
          }
          const status = await executor.jobStatus({
            jobId: job.jobId,
            namespace: job.namespace,
          });
          if (status.state === "running") {
            return { status: "processing", jobId: job.jobId };
          }
          if (status.state === "unknown") {
            return { status: "unknown", jobId: job.jobId };
          }

          return settleTerminalJob(statusId, executor, job, status);
        } catch (cause) {
          return toolError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      },
    }),
  };
}

function sandboxForNamespace(
  context: AsyncStatusContext,
  namespace: string,
): SandboxExecutorConfig | undefined {
  return (context.workspaces ?? []).find(
    (entry) => entry.namespace === namespace && entry.sandbox,
  )?.sandbox;
}

function sandboxJobRef(input: unknown): SandboxJobRef | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (
    record.kind !== "sandbox_job" ||
    typeof record.namespace !== "string" ||
    typeof record.jobId !== "string"
  ) {
    return undefined;
  }

  return { namespace: record.namespace, jobId: record.jobId };
}

// A settled background-job response carries the captured logs (see
// settleTerminalJob); non-job async tools return undefined here.
function settledJobLogs(response: JSONValue | undefined): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const logs = (response as { logs?: unknown }).logs;

  return typeof logs === "string" ? logs : undefined;
}

async function settleTerminalJob(
  resultId: string,
  executor: SandboxExecutor,
  job: SandboxJobRef,
  status: SandboxJobStatus,
): Promise<JSONValue> {
  const logs = executor.jobLogs
    ? (
        await executor.jobLogs({
          jobId: job.jobId,
          namespace: job.namespace,
          outputLimitBytes: JOB_LOG_LIMIT_BYTES,
        })
      ).logs
    : "";
  if (status.state === "completed") {
    await markAsyncToolResultCompleted({
      resultId: resultId,
      response: {
        state: status.state,
        exitCode: status.exitCode ?? null,
        logs: logs,
      },
    });
  } else {
    await markAsyncToolResultFailed({
      resultId: resultId,
      error: `Job exited with code ${status.exitCode ?? "unknown"}.${logs ? `\n${logs}` : ""}`,
    });
  }
  // Consumed through the poll, so the auto-delivery resume must not re-inject it.
  await markAsyncToolResultObserved(resultId);

  return {
    status: status.state,
    jobId: job.jobId,
    exitCode: status.exitCode ?? null,
    logs: logs,
  };
}
