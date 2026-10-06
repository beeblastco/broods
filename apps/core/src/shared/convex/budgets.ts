/**
 * BudgetStore implementation over `account/budget.ts`. A usage write never
 * reaches the run that caused it: it retries in the background, and a write
 * that still fails is logged with its usage.
 */

import type { BudgetStatus } from "@broods/convex/model/usageMeter";
import { logError } from "../log.ts";
import type { Storage } from "../storage.ts";
import { getConvexClient } from "./client.ts";

// A usage write is retried through a Convex blip before it is given up. The
// caller never waits on it, so the backoff costs a run nothing.
const RECORD_RETRY_DELAYS_MS = [0, 1_000, 5_000, 30_000];

const internal: any = require("@broods/convex/_generated/api").internal;

export const budgets: Storage["budgets"] = {
  claimWarning: async function (accountId): Promise<boolean> {
    return (await getConvexClient().mutation(
      internal.account.budget.claimWarning,
      { accountId: accountId },
    )) as boolean;
  },
  get: async function (accountId): Promise<BudgetStatus | null> {
    return (await getConvexClient().query(internal.account.budget.get, {
      accountId: accountId,
    })) as BudgetStatus | null;
  },
  record: async function (accountId, usage): Promise<void> {
    // One id for every attempt: a retry after a lost response is applied once.
    const writeId = crypto.randomUUID();
    for (const [attempt, delayMs] of RECORD_RETRY_DELAYS_MS.entries()) {
      await Bun.sleep(delayMs);
      try {
        await getConvexClient().mutation(internal.account.budget.record, {
          accountId: accountId,
          usage: usage,
          writeId: writeId,
        });

        return;
      } catch (err) {
        if (attempt < RECORD_RETRY_DELAYS_MS.length - 1) continue;
        // The usage rides the log line so it can still be added by hand.
        logError("Usage meter write failed (convex)", {
          accountId: accountId,
          usage: usage,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  },
};
