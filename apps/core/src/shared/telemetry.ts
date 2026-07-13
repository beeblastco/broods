/**
 * Usage metering — fire-and-forget write via the active StorageProvider.
 *
 * The event path (Convex hot table telemetryEvents) has been removed; log
 * lines and spans now flow to NATS + OTLP via _shared/log.ts and otel.ts.
 * This file owns only the per-task usage row: one write per finished agent
 * invocation, forwarded to the Convex StorageProvider. Never throws into the
 * agent path.
 */

import { logError } from "./log.ts";
import { getStorage } from "./storage/index.ts";
import type { UsageTaskInput } from "./storage/types.ts";

export type { UsageTaskInput };

/**
 * Record one finished-task usage row via the active StorageProvider.
 * Fire-and-forget: errors are logged, never re-thrown.
 */
export async function recordUsageTask(input: UsageTaskInput): Promise<void> {
  try {
    await getStorage().usage.recordTask(input);
  } catch (err) {
    logError("Usage write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
