/**
 * Scheduled jobs. Distinct from `cron.ts` (per-account agent cron CRUD): this is
 * the Convex platform cron registry. Keep it small — only background maintenance.
 */

import { cronJobs } from "convex/server";

const crons = cronJobs();

export default crons;
