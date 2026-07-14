/**
 * Usage metering — fire-and-forget write via the active storage boundary.
 *
 * The event path (Convex hot table telemetryEvents) has been removed; log
 * lines and spans now flow to NATS + OTLP via _shared/log.ts and otel.ts.
 * This file owns only the per-task usage row: one write per finished agent
 * invocation, forwarded to Convex storage. Never throws into the
 * agent path.
 */

import { logError } from "./log.ts";
import { getStorage } from "./storage.ts";
import type { TaskUsageInput } from "./storage.ts";

export type { TaskUsageInput };

/**
 * Record one finished-task usage row via the active storage boundary.
 * Fire-and-forget: errors are logged, never re-thrown.
 */
export async function recordTaskUsage(input: TaskUsageInput): Promise<void> {
  try {
    await getStorage().taskUsage.record(input);
  } catch (err) {
    logError("Usage write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
