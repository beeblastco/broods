/**
 * Usage metering: one per-task row per finished agent invocation, written
 * fire-and-forget through the active storage boundary. Never throws into the
 * agent path. Log lines and spans go to NATS + OTLP via shared/log.ts and
 * shared/otel.ts instead.
 */

import { logError } from "./log.ts";
import { getStorage } from "./storage.ts";
import type { TaskUsageInput } from "./storage.ts";

export type { TaskUsageInput };

export async function recordTaskUsage(input: TaskUsageInput): Promise<void> {
  try {
    await getStorage().taskUsage.record(input);
  } catch (err) {
    logError("Usage write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
