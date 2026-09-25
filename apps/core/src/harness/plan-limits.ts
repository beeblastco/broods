/**
 * Plan enforcement in core: the monthly compute budget and burst protection.
 * Every new run (API, channel message, cron fire) asks `admitRun` before it
 * touches a model or a sandbox; every sandbox launch asks
 * `assertSandboxBudget`. Usage only core sees (hosted-MCP invokes, media
 * egress, attachment ingress) goes to the meter through `recordUsage`.
 * Nothing is enforced unless
 * the Convex deployment is the managed service (`BROODS_MANAGED_SERVICE`).
 */

import { rateLimitHeaders } from "@broods/convex/model/httpJson";
import {
  BUDGET_EXHAUSTED,
  BUDGET_WARNING_RATIO,
  PLAN_LIMIT_EXCEEDED,
} from "@broods/convex/model/planLimits";
import type { BudgetStatus } from "@broods/convex/model/usageMeter";
import { errorResponse } from "../shared/http.ts";
import { waitUntil } from "../shared/in-flight.ts";
import { logWarn } from "../shared/log.ts";
import { getStorage, type Storage } from "../shared/storage.ts";

const WINDOW_MS = 60_000;
// How stale a budget read may be. Usage that lands inside it can take an
// account a little past its budget, never far.
const BUDGET_TTL_MS = 30_000;

/** Why a run was refused, and what the HTTP caller gets for it. */
export interface PlanRefusal {
  kind: "budget" | "rate";
  message: string;
  /** Rate refusals only: the per-minute limit and when the window turns over. */
  limit?: number;
  retryAfterSeconds?: number;
}

export interface Admission {
  refusal: PlanRefusal | null;
  /** This month's 80% notice, for the one channel run that claimed it. */
  warning: string | null;
}

/** A sandbox launch refused because the budget is used up. */
export class BudgetExhaustedError extends Error {}

/** One account's fixed one-minute window of admitted runs. */
interface AccountWindow {
  startedAt: number;
  runs: number;
}

interface CachedBudget {
  status: BudgetStatus | null;
  expiresAt: number;
}

// Core runs a single replica (apps/core AGENTS.md), so this process sees every
// run and an in-memory window is the whole count. A restart forgets at most
// one window. A second replica would split it and double the burst limit.
const windows = new Map<string, AccountWindow>();
const budgets = new Map<string, CachedBudget>();

/**
 * Admit one run for the account and count it.
 * @param options.claimWarning claim the 80% notice for this run (channel intake)
 */
export async function admitRun(
  accountId: string,
  options: { claimWarning?: boolean } = {},
): Promise<Admission> {
  const status = await budgetFor(accountId);
  if (!status?.enforced) return { refusal: null, warning: null };
  if (status.usedEur >= status.limitEur) {
    return { refusal: budgetRefusal(status), warning: null };
  }
  const now = Date.now();
  const window = currentWindow(accountId, now);
  if (window.runs >= status.runsPerMinute) {
    return {
      refusal: {
        kind: "rate",
        message: `Rate limit reached: the ${status.plan} plan admits ${status.runsPerMinute} runs per minute.`,
        limit: status.runsPerMinute,
        retryAfterSeconds: Math.ceil(
          (window.startedAt + WINDOW_MS - now) / 1000,
        ),
      },
      warning: null,
    };
  }
  window.runs += 1;

  return {
    refusal: null,
    warning: options.claimWarning
      ? await claimWarning(accountId, status)
      : null,
  };
}

/** Throws `BudgetExhaustedError` when the account may not start compute. */
export async function assertSandboxBudget(accountId: string): Promise<void> {
  const status = await budgetFor(accountId);
  if (status?.enforced && status.usedEur >= status.limitEur) {
    throw new BudgetExhaustedError(budgetRefusal(status).message);
  }
}

/**
 * 402 `budget_exhausted`, or 429 `plan_limit_exceeded` with `Retry-After`.
 * 402, not 429 or 403: waiting a minute does not help and the key is fine;
 * the account has to upgrade or wait for next month.
 */
export function planRefusalResponse(refusal: PlanRefusal): Response {
  if (refusal.kind === "budget") {
    return errorResponse(402, refusal.message, { code: BUDGET_EXHAUSTED });
  }

  return errorResponse(
    429,
    refusal.message,
    { code: PLAN_LIMIT_EXCEEDED },
    rateLimitHeaders(refusal.limit ?? 0, refusal.retryAfterSeconds ?? 1),
  );
}

/**
 * Add usage core measured to the account's meter, in the background. The write
 * is registered with `waitUntil`, so shutdown drains it before the process exits.
 */
export function recordUsage(
  accountId: string,
  usage: Parameters<Storage["budgets"]["record"]>[1],
): void {
  waitUntil(getStorage().budgets.record(accountId, usage));
}

export function resetPlanLimitsForTests(): void {
  windows.clear();
  budgets.clear();
}

// A failed lookup admits: enforcement is a cost ceiling, not an auth check,
// and a run cannot get far while Convex is unreachable anyway.
async function budgetFor(accountId: string): Promise<BudgetStatus | null> {
  const cached = budgets.get(accountId);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  try {
    const status = await getStorage().budgets.get(accountId);
    budgets.set(accountId, {
      status: status,
      expiresAt: Date.now() + BUDGET_TTL_MS,
    });

    return status;
  } catch (err) {
    logWarn("Budget lookup failed; admitting", {
      accountId: accountId,
      error: err instanceof Error ? err.message : String(err),
    });

    return null;
  }
}

function budgetRefusal(status: BudgetStatus): PlanRefusal {
  return {
    kind: "budget",
    message: `This account has used its monthly compute allowance for ${status.month} on the ${status.plan} plan. Upgrade to keep running agents, or wait for next month.`,
  };
}

async function claimWarning(
  accountId: string,
  status: BudgetStatus,
): Promise<string | null> {
  if (status.warned || status.usedEur < status.limitEur * BUDGET_WARNING_RATIO)
    return null;
  // Whoever loses the race sees `warned` on its next read.
  status.warned = true;
  // The notice is optional: a failed claim skips it and never fails the run.
  const claimed = await getStorage()
    .budgets.claimWarning(accountId)
    .catch((err: unknown): boolean => {
      logWarn("Budget warning claim failed; skipping the notice", {
        accountId: accountId,
        error: err instanceof Error ? err.message : String(err),
      });

      return false;
    });
  if (!claimed) return null;

  return `This account has used ${Math.floor(BUDGET_WARNING_RATIO * 100)}% of its monthly compute allowance on the ${status.plan} plan. Runs stop when it is used up.`;
}

function currentWindow(accountId: string, now: number): AccountWindow {
  const existing = windows.get(accountId);
  if (existing && now - existing.startedAt < WINDOW_MS) return existing;
  const fresh: AccountWindow = { startedAt: now, runs: 0 };
  windows.set(accountId, fresh);

  return fresh;
}
