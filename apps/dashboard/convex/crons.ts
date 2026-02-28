/**
 * Scheduled cron jobs for background maintenance tasks.
 */
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/** Reap tasks stuck in running/rerun/tool_call states beyond the 10-minute TTL. */
crons.interval("reap stuck tasks", { minutes: 5 }, internal.tasks.reapStuckTasksInternal);

export default crons;
