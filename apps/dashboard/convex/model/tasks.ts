/**
 * Task guards and status update helpers used by session/task orchestration.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Statuses that represent a finished task. */
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const TERMINAL_OR_RESUMABLE_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "waiting_subagent",
]);

/**
 * Throw if the session already has an active non-terminal task.
 * @param ctx Query or mutation context
 * @param sessionId Session ID to validate
 * @throws Error if another task is still active
 */
export async function assertNoActiveTask(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<"sessions">,
): Promise<void> {
  const latestTask = await ctx.db
    .query("tasks")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .order("desc")
    .first();

  if (latestTask && !TERMINAL_OR_RESUMABLE_STATUSES.has(latestTask.status)) {
    throw new Error(
      `Session already has an active task (${latestTask._id}, status: ${latestTask.status})`,
    );
  }
}

/**
 * Shared task status update logic used by internal and gateway entrypoints.
 * @param ctx Mutation context
 * @param args Task status payload
 * @returns null
 * @throws Error if the task does not exist or required fields are missing
 */
export async function updateTaskStatus(
  ctx: MutationCtx,
  args: {
    taskId: Id<"tasks">;
    status: "pending" | "running" | "rerun" | "tool_call" | "waiting_subagent" | "completed" | "failed" | "cancelled";
    result?: unknown[];
    error?: string;
  },
): Promise<null> {
  const { taskId, status, result, error } = args;

  const task = await ctx.db.get(taskId);
  if (!task) {
    throw new Error("Task not found");
  }

  // Skip if task already in a terminal state to prevent accidental overwrites.
  if (TERMINAL_STATUSES.has(task.status)) {
    return null;
  }

  if (status === "completed" && result === undefined) {
    throw new Error("Result is required when marking task as completed");
  }

  if (status === "failed" && error === undefined) {
    throw new Error("Error message is required when marking task as failed");
  }

  await ctx.db.patch(taskId, {
    status: status,
    ...(status === "completed" ? { result: result, error: undefined } : {}),
    ...(status === "failed" ? { error: error } : {}),
    ...(status === "cancelled" ? { cancelledAt: Date.now() } : {}),
    ...(
      status === "completed" || status === "failed" || status === "cancelled"
        ? { completedAt: Date.now() }
        : {}
    ),
  });

  return null;
}

/** Non-terminal statuses that indicate a task is still active. */
const ACTIVE_STATUSES = new Set(["running", "rerun", "tool_call"]);

/** Maximum time a task can stay in an active status before being reaped (10 minutes). */
const STUCK_TASK_TTL_MS = 10 * 60 * 1000;

/**
 * Marks tasks stuck in active states beyond the TTL as failed.
 * Designed to be called by a cron job to recover from crashed agent processes.
 * @param ctx Mutation context
 * @returns Number of tasks reaped
 */
export async function reapStuckTasks(ctx: MutationCtx): Promise<number> {
  const cutoff = Date.now() - STUCK_TASK_TTL_MS;
  let reaped = 0;

  for (const status of ACTIVE_STATUSES) {
    const tasks: Doc<"tasks">[] = await ctx.db
      .query("tasks")
      .withIndex("by_type_and_status", (q) => q.eq("type", "agent").eq("status", status as "running"))
      .collect();

    for (const task of tasks) {
      if (task._creationTime < cutoff) {
        await ctx.db.patch(task._id, {
          status: "failed",
          error: "Task timed out: agent process did not complete within the expected window",
          completedAt: Date.now(),
        });
        reaped += 1;
      }
    }
  }

  return reaped;
}
