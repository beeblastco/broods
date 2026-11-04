import { rateLimitHeaders } from "@broods/convex/model/httpJson";
import {
  BUDGET_EXHAUSTED,
  BUDGET_WARNING_RATIO,
  capsReached,
  PLAN_LIMIT_EXCEEDED,
  PLAN_LIMITS,
} from "@broods/convex/model/planLimits";
import type { BudgetStatus } from "@broods/convex/model/usageMeter";
import { errorResponse } from "../shared/http.ts";
import { waitUntil } from "../shared/in-flight.ts";
import { logWarn } from "../shared/log.ts";
import {
  getStorage,
  type Storage,
  type UsageSource,
} from "../shared/storage.ts";

const WINDOW_MS = 60_000;
// Usage landing inside this TTL can take an account a little past its budget, never far.
const BUDGET_TTL_MS = 30_000;
const USAGE_LINGER_MS = 1_000;
// Every meter field, so a field added to MeterUsage fails here until recordUsageSoon sums it.
const METER_FIELDS: { [Field in keyof Required<MeterUsage>]: Field } = {
  egressGb: "egressGb",
  hostedMcpGbSeconds: "hostedMcpGbSeconds",
  hostedMcpRequests: "hostedMcpRequests",
  ingressGb: "ingressGb",
  workerMs: "workerMs",
  workerRequests: "workerRequests",
};

type MeterUsage = Parameters<Storage["budgets"]["record"]>[1];

export interface PlanRefusal {
  kind: "budget" | "rate";
  message: string;
  limit?: number;
  retryAfterSeconds?: number;
}

export interface Admission {
  refusal: PlanRefusal | null;
  warning: string | null;
  countedIn?: number;
}

export class BudgetExhaustedError extends Error {}

interface AccountWindow {
  startedAt: number;
  runs: number;
}

interface CachedBudget {
  status: BudgetStatus | null;
  expiresAt: number;
}

interface LingeringUsage {
  accountId: string;
  source: UsageSource | undefined;
  usage: MeterUsage;
}

// Exact only while core is a single replica (apps/core AGENTS.md); two would double the burst.
const windows = new Map<string, AccountWindow>();
const budgets = new Map<string, CachedBudget>();
const lingering = new Map<string, LingeringUsage>();
let lingerUsage = true;

export async function admitRun(
  accountId: string,
  options: { claimWarning?: boolean; count?: boolean } = {},
): Promise<Admission> {
  const status = await budgetFor(accountId);
  if (!status?.enforced) return { refusal: null, warning: null };
  if (status.usedPercent >= 100) {
    return { refusal: budgetRefusal(status), warning: null };
  }
  const now = Date.now();
  const window = currentWindow(accountId, now, options.count !== false);
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
  if (options.count === false) return { refusal: null, warning: null };
  window.runs += 1;

  return {
    refusal: null,
    countedIn: window.startedAt,
    warning: options.claimWarning
      ? await claimWarning(accountId, status)
      : null,
  };
}

export function refundRun(admission: Admission, accountId: string): void {
  const window = windows.get(accountId);
  if (window && window.startedAt === admission.countedIn && window.runs > 0) {
    window.runs -= 1;
  }
}

export async function assertSandboxBudget(accountId: string): Promise<void> {
  const status = await budgetFor(accountId);
  if (status?.enforced && status.usedPercent >= 100) {
    throw new BudgetExhaustedError(budgetRefusal(status).message);
  }
}

// 402, not 429 or 403, for a budget: waiting a minute will not help and the key is fine.
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

export function planRefusalText(refusal: PlanRefusal): string {
  return refusal.retryAfterSeconds === undefined
    ? refusal.message
    : `${refusal.message} Try again in ${refusal.retryAfterSeconds} seconds.`;
}

export function recordUsage(
  accountId: string,
  usage: MeterUsage,
  source?: UsageSource,
): void {
  waitUntil(getStorage().budgets.record(accountId, usage, source));
}

// Sums one account and source's usage for a second into one write. Budget reads are cached for
// BUDGET_TTL_MS already, so the second's delay barely moves what they see.
export function recordUsageSoon(
  accountId: string,
  usage: MeterUsage,
  source?: UsageSource,
): void {
  if (!lingerUsage) {
    recordUsage(accountId, usage, source);

    return;
  }
  const key = JSON.stringify([
    accountId,
    source?.projectId,
    source?.agentId,
    source?.workspaceId,
  ]);
  const pending = lingering.get(key);
  if (pending) {
    for (const name of Object.values(METER_FIELDS)) {
      const amount = usage[name];
      if (amount !== undefined)
        pending.usage[name] = (pending.usage[name] ?? 0) + amount;
    }

    return;
  }
  const batch: LingeringUsage = {
    accountId: accountId,
    source: source,
    usage: { ...usage },
  };
  lingering.set(key, batch);
  waitUntil(
    Bun.sleep(USAGE_LINGER_MS).then((): Promise<void> =>
      sendLingering(key, batch),
    ),
  );
}

// At shutdown, what waits goes out now and later usage at once, as recordUsage sends it.
export function stopLingeringUsage(): void {
  lingerUsage = false;
  for (const [key, batch] of lingering) waitUntil(sendLingering(key, batch));
}

export function resetPlanLimitsForTests(): void {
  windows.clear();
  budgets.clear();
  lingering.clear();
  lingerUsage = true;
}

async function sendLingering(
  key: string,
  batch: LingeringUsage,
): Promise<void> {
  if (lingering.get(key) !== batch) return;
  lingering.delete(key);
  await getStorage().budgets.record(batch.accountId, batch.usage, batch.source);
}

// Fails open: a cost ceiling, not an auth check, and a run stalls without Convex anyway.
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
  const reached = capsReached(status.shares);
  const storage = `its storage limit of ${storageLimit(status)}`;
  const monthly = `one of its monthly resource caps for ${status.month}`;
  const canUpgrade = status.plan === "free";

  return {
    kind: "budget",
    message: !reached.storage
      ? `This account has reached ${monthly} on the ${status.plan} plan. Upgrade to keep running agents, or wait for next month.`
      : reached.monthly
        ? `This account has reached ${storage} and ${monthly} on the ${status.plan} plan. Delete files, then ${canUpgrade ? "upgrade or " : ""}wait for next month, to keep running agents; storage is measured once a day.`
        : `This account has reached ${storage} on the ${status.plan} plan. Delete files${canUpgrade ? " or upgrade" : ""} to keep running agents; storage is measured once a day.`,
  };
}

function storageLimit(status: BudgetStatus): string {
  return `${PLAN_LIMITS[status.plan].caps.storageGb} GB of workspaces and files`;
}

async function claimWarning(
  accountId: string,
  status: BudgetStatus,
): Promise<string | null> {
  if (status.warned || status.usedPercent < BUDGET_WARNING_RATIO * 100)
    return null;
  status.warned = true;
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

  const percent = Math.floor(BUDGET_WARNING_RATIO * 100);

  return capsReached(status.shares, percent).storage
    ? `This account has used ${percent}% of its storage limit of ${storageLimit(status)} on the ${status.plan} plan. Runs stop when it is full.`
    : `This account has used ${percent}% of one of its monthly resource caps on the ${status.plan} plan. Runs stop when a cap is reached.`;
}

function currentWindow(
  accountId: string,
  now: number,
  open: boolean,
): AccountWindow {
  const existing = windows.get(accountId);
  if (existing && now - existing.startedAt < WINDOW_MS) return existing;
  const fresh: AccountWindow = { startedAt: now, runs: 0 };
  if (open) windows.set(accountId, fresh);

  return fresh;
}
