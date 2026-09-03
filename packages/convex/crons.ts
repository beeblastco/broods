/**
 * Scheduled jobs. Distinct from `agent/crons.ts` (per-account agent cron CRUD):
 * this is the Convex platform cron registry. Keep it small — only background
 * maintenance.
 */

import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Expiry is advisory cleanup: admission and drain already check expiresAt
// inline, so a lower cadence only delays how fast abandoned rows are pruned.
crons.interval(
  "maintain runtime ingress",
  { minutes: 5 },
  internal.runtimeIngress.maintain,
  {},
);
crons.interval(
  "prune config audit events",
  { hours: 24 },
  internal.config.auditEvents.pruneExpired,
  {},
);
crons.interval(
  "prune cron run history",
  { hours: 24 },
  internal.agent.crons.pruneExpiredRuns,
  {},
);
crons.interval(
  "prune runtime persistence",
  { hours: 1 },
  internal.runtime.pruneExpired,
  {},
);
// Expiry is checked inline on every session resolve; this only bounds growth.
crons.interval(
  "prune role sessions",
  { hours: 24 },
  internal.account.roles.pruneExpiredSessions,
  {},
);
// Blobs minted through an upload URL but never registered; walks storage
// oldest-first and reschedules itself page by page.
crons.interval(
  "prune orphan uploads",
  { hours: 24 },
  internal.account.uploads.pruneOrphans,
  {},
);
crons.interval(
  "prune task usage samples",
  { hours: 24 },
  internal.usage.pruneExpiredTaskUsage,
  {},
);
// The write seams keep this projection live; the sweep seeds it at cutover and
// self-heals any seam a future writer forgets.
crons.interval(
  "reconcile channel endpoints",
  { hours: 1 },
  internal.channel.connections.reconcile,
  {},
);

export default crons;
