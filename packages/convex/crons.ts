/**
 * Scheduled jobs. Distinct from `agent/crons.ts` (per-account agent cron CRUD):
 * this is the Convex platform cron registry. Keep it small, only background
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
  "prune config auth failures",
  { hours: 24 },
  internal.config.authFailures.pruneExpired,
  {},
);
// Rows past an account's retention go oldest first, never one its sink has
// not exported, so the chain stays verifiable from the oldest kept row to the
// head.
crons.interval(
  "prune expired audit events",
  { hours: 24 },
  internal.audit.ledger.pruneExpired,
  {},
);
crons.interval(
  "export audit events",
  { minutes: 10 },
  internal.audit.sinks.exportDue,
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
// Blobs minted through an upload URL but never registered by a workspace file.
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
// Sandbox writes bill their own running time; this catches the ones nothing
// wrote to within the hour.
crons.interval(
  "accrue sandbox usage",
  { hours: 1 },
  internal.sandbox.instances.accrueRecent,
  {},
);
crons.interval(
  "prune usage write ids",
  { hours: 24 },
  internal.account.budget.pruneUsageWrites,
  {},
);
crons.interval(
  "snapshot storage usage",
  { hours: 24 },
  internal.aws.storageMeter.snapshotAll,
  {},
);
// The write seams keep this projection live; the sweep self-heals any seam a
// future writer forgets.
crons.interval(
  "reconcile channel endpoints",
  { hours: 1 },
  internal.channel.endpointReconcile.reconcile,
  {},
);

// A Gmail watch lapses after seven days; renewing daily leaves room for misses.
crons.interval(
  "renew gmail watches",
  { hours: 24 },
  internal.channel.gmail.renewAll,
  {},
);

export default crons;
