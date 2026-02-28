/**
 * Task state management for agent execution.
 */
import { withSystemFields } from "convex-helpers/validators";
import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { reapStuckTasks, updateTaskStatus } from "./model/tasks";
import { verifySessionOwnership } from "./model/ownership";
import { taskFields, taskStatusEnum } from "./schema";

/** Validator for task records with system fields. */
const taskValidator = v.object(withSystemFields("tasks", taskFields));

/**
 * List all tasks for a session that belongs to the authenticated user.
 * @param sessionId Session ID
 * @returns Tasks sorted newest first
 */
export const list = query({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.array(taskValidator),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    // Check authenticated user
    const user = await ctx.auth.getUserIdentity();
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    await verifySessionOwnership(ctx, sessionId, user.subject);

    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .collect();

    return tasks;
  },
});

/**
 * Get the latest task for a session.
 * @param sessionId Session ID
 * @returns Most recent task or null
 */
export const getBySessionInternal = internalQuery({
  args: {
    sessionId: v.id("sessions"),
  },
  returns: v.union(taskValidator, v.null()),
  handler: async (ctx, args) => {
    const { sessionId } = args;

    const task = await ctx.db
      .query("tasks")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
      .order("desc")
      .first();

    return task;
  },
});

/**
 * Update task status and terminal metadata.
 * @param taskId Task ID
 * @param status Next task status
 * @param result Optional result payload for completed tasks
 * @param error Optional error message for failed tasks
 * @returns null
 * @throws Error if the task does not exist or required fields are missing
 */
export const updateStatusInternal = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: taskStatusEnum,
    result: v.optional(v.array(v.any())),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    return await updateTaskStatus(ctx, args);
  },
});

/**
 * Gateway task status update entrypoint with shared-secret auth.
 * @param taskId Task ID
 * @param status Next task status
 * @param result Optional task result
 * @param error Optional task error
 * @returns null
 */
export const updateForGateway = internalMutation({
  args: {
    taskId: v.id("tasks"),
    status: taskStatusEnum,
    result: v.optional(v.array(v.any())),
    error: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    return await updateTaskStatus(ctx, args);
  },
});

/**
 * Reap tasks stuck in active states beyond the TTL (10 min).
 * Called by cron to recover from crashed agent processes.
 * @returns Number of tasks reaped
 */
export const reapStuckTasksInternal = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    return await reapStuckTasks(ctx);
  },
});

