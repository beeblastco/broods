/**
 * Scheduled jobs. Distinct from `cron.ts` (per-account agent cron CRUD): this is
 * the Convex platform cron registry. Keep it small — only background maintenance.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("prune config audit events", { hours: 24 }, internal.configAuditEvents.pruneExpired, {});
crons.interval("prune runtime persistence", { hours: 1 }, internal.runtime.pruneExpired, {});

export default crons;
