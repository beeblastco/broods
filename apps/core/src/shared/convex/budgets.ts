/**
 * BudgetStore implementation over `account/budget.ts`. Usage writes are
 * best-effort like `usage.ts`: a failed write is logged and never reaches the
 * run that caused it.
 */

import type { BudgetStatus } from "@broods/convex/model/usageMeter";
import { logError } from "../log.ts";
import type { Storage } from "../storage.ts";
import { getConvexClient } from "./client.ts";

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
    try {
      await getConvexClient().mutation(internal.account.budget.record, {
        accountId: accountId,
        usage: usage,
      });
    } catch (err) {
      logError("Usage meter write failed (convex)", {
        accountId: accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
