/**
 * Usage metering: one per-task row per finished agent invocation, written
 * fire-and-forget through the active storage boundary. Never throws into the
 * agent path. Log lines and spans go to NATS + OTLP via shared/log.ts and
 * shared/otel.ts instead.
 */

import { logError } from "./log.ts";
import { getStorage } from "./storage.ts";
import type { AuditLedgerInput, TaskUsageInput } from "./storage.ts";

export type { AuditLedgerInput, TaskUsageInput };

/** Append one audit ledger row. Never throws into the agent path; a run with no account has no ledger. */
export async function recordAuditEvent(input: AuditLedgerInput): Promise<void> {
  if (!input.accountId) return;
  try {
    await getStorage().auditLedger.append(input);
  } catch (err) {
    logError("Audit ledger write failed", {
      action: input.action,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function recordTaskUsage(input: TaskUsageInput): Promise<void> {
  try {
    await getStorage().taskUsage.record(input);
  } catch (err) {
    logError("Usage write failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
