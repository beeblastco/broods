/**
 * AuditLedgerStore implementation. Appends one row through
 * internal.audit.ledger.record; the chain hash and seq are computed in Convex
 * so core never holds the head. Errors are logged and never reach the run.
 */

const internal: any = require("@broods/convex/_generated/api").internal;
import { logError } from "../log.ts";
import type { Storage } from "../storage.ts";
import { getConvexClient } from "./client.ts";

export const auditLedger: Storage["auditLedger"] = {
  append: async function (input): Promise<void> {
    try {
      await getConvexClient().mutation(
        internal.audit.ledger.record,
        {
          accountId: input.accountId as any,
          traceId: input.traceId,
          actor: { kind: "agent", agentId: input.agentId },
          action: input.action,
          resource: input.resource,
          summary: input.summary,
          detailsJson:
            input.details === undefined
              ? undefined
              : JSON.stringify(input.details),
        },
        { skipQueue: true },
      );
    } catch (err) {
      logError("Audit ledger write failed (convex)", {
        action: input.action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
