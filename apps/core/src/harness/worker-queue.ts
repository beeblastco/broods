import { AsyncLocalStorage } from "node:async_hooks";
import {
  MAX_RUN_SLOTS,
  positiveIntegerEnv,
  WORKER_TIMEOUT_BUDGET_MS,
} from "../shared/env.ts";
import type { RequestContext } from "../shared/http.ts";
import { logError, logWarn } from "../shared/log.ts";
import {
  DEFAULT_CONVERSATION_LEASE_TTL_MS,
  renewIngressOwner,
  type LiveOwner,
} from "./ingress.ts";

const MAX_INPROCESS_WORKERS = positiveIntegerEnv("MAX_INPROCESS_WORKERS", 8);
const WORKER_SLOT_GRACE_MS = 5_000;
const MAX_PENDING_WORKER_RUNS = 1000;
export const WORKER_QUEUE_FULL = "In-process worker queue is full";
const QUEUED_LEASE_RENEW_INTERVAL_MS = DEFAULT_CONVERSATION_LEASE_TTL_MS / 3;
const QUEUED_LEASE_RENEW_CONCURRENCY = 16;
const inProcessWorkers = new Set<Promise<void>>();
type PendingWorkerRun = [
  kind: string,
  start: () => void,
  lease: LiveOwner | undefined,
];
const pendingWorkerRuns: PendingWorkerRun[] = [];

let activeInProcessWorkers = 0;
let heldQueuePlaces = 0;
const queuePlace = new AsyncLocalStorage<{ held: boolean }>();
let queuedLeaseTimer: ReturnType<typeof setInterval> | undefined;
let renewingQueuedLeases = false;

type InProcessWorkerRun = (context: RequestContext) => Promise<unknown>;

export function dispatchInProcessWorker(
  kind: string,
  run: InProcessWorkerRun,
  lease?: LiveOwner,
): void {
  const runAbort = new AbortController();
  let slotsUsed = 0;
  let releaseSlot: (() => void) | undefined;
  // Settles the tracked promise on an overrun, so a stuck run never blocks the shutdown drain.
  let abandon: (() => void) | undefined;
  const context: RequestContext = {
    requestId: crypto.randomUUID(),
    deadlineMs: Date.now(),
    waitUntil: () => {},
    abortSignal: runAbort.signal,
  };
  const takeSlot = (): void => {
    activeInProcessWorkers += 1;
    slotsUsed += 1;
    context.deadlineMs = Date.now() + WORKER_TIMEOUT_BUDGET_MS;
    if (slotsUsed >= MAX_RUN_SLOTS) delete context.yieldSlot;
    // An overrun frees the slot and aborts the run, so stuck runs cannot pin the pod's slots.
    const slotTimer = setTimeout((): void => {
      logError("In-process worker exceeded deadline; reclaiming slot", {
        kind: kind,
        budgetMs: WORKER_TIMEOUT_BUDGET_MS,
      });
      runAbort.abort(new Error("I ran out of time on this turn."));
      releaseSlot?.();
      abandon?.();
    }, WORKER_TIMEOUT_BUDGET_MS + WORKER_SLOT_GRACE_MS);
    slotTimer.unref?.();
    releaseSlot = (): void => {
      clearTimeout(slotTimer);
      releaseSlot = undefined;
      activeInProcessWorkers -= 1;
      startNextWorker();
    };
  };
  context.yieldSlot = async (heldLease): Promise<void> => {
    if (runAbort.signal.aborted || !releaseSlot) return;
    releaseSlot();
    // A coordinator reading the old deadline while queued would take the run for out of time.
    context.deadlineMs = Number.POSITIVE_INFINITY;
    await new Promise<void>((resolve): void => {
      enqueueWorker(
        [
          kind,
          (): void => {
            takeSlot();
            resolve();
          },
          heldLease,
        ],
        // A run stopped mid-turn holding its lease is never load-shed.
        false,
      );
    });
  };
  const place = queuePlace.getStore();
  const placed = place?.held === true;
  if (place && placed) {
    place.held = false;
    heldQueuePlaces -= 1;
  }
  enqueueWorker(
    [
      kind,
      (): void => {
        takeSlot();
        const execution = run(context).then(
          (): void => undefined,
          (err): void => {
            logError("In-process worker failed", {
              kind: kind,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        );
        const worker: Promise<void> = Promise.race([
          execution,
          new Promise<void>((resolve): void => {
            abandon = resolve;
          }),
        ]).finally((): void => {
          releaseSlot?.();
          inProcessWorkers.delete(worker);
        });
        inProcessWorkers.add(worker);
      },
      lease,
    ],
    !placed,
  );
}

// Holds a place while `admit` records its run, so concurrent requests never overfill the
// queue; the first dispatch inside `admit` takes the place and is never shed.
export async function withQueuePlace<T>(
  admit: () => Promise<T>,
): Promise<T | undefined> {
  if (workerQueueFull()) return undefined;
  const place = { held: true };
  heldQueuePlaces += 1;
  try {
    return await queuePlace.run(place, admit);
  } finally {
    if (place.held) {
      place.held = false;
      heldQueuePlaces -= 1;
    }
  }
}

export async function drainInProcessWorkers(): Promise<void> {
  while (inProcessWorkers.size > 0) {
    await Promise.allSettled(inProcessWorkers);
  }
}

async function renewQueuedLeases(): Promise<void> {
  if (renewingQueuedLeases) return;
  renewingQueuedLeases = true;
  try {
    const waiting = pendingWorkerRuns.filter((entry) => entry[2]);
    for (
      let offset = 0;
      offset < waiting.length;
      offset += QUEUED_LEASE_RENEW_CONCURRENCY
    ) {
      await Promise.all(
        waiting
          .slice(offset, offset + QUEUED_LEASE_RENEW_CONCURRENCY)
          .map(renewQueuedLease),
      );
    }
  } finally {
    renewingQueuedLeases = false;
  }
}

async function renewQueuedLease(entry: PendingWorkerRun): Promise<void> {
  const [kind, , lease] = entry;
  if (!lease) return;
  try {
    const renewal = await renewIngressOwner(lease);
    if (renewal === "renewed") return;
    entry[2] = undefined;
    logWarn("Queued worker lease was not renewed", {
      kind: kind,
      conversationKey: lease.conversationKey,
      renewal: renewal,
    });
  } catch (err) {
    logError("Queued worker lease renewal failed", {
      kind: kind,
      conversationKey: lease.conversationKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function workerQueueFull(): boolean {
  return (
    activeInProcessWorkers + pendingWorkerRuns.length + heldQueuePlaces >=
    MAX_INPROCESS_WORKERS + MAX_PENDING_WORKER_RUNS
  );
}

function enqueueWorker(entry: PendingWorkerRun, loadShed = true): void {
  if (activeInProcessWorkers < MAX_INPROCESS_WORKERS) {
    entry[1]();

    return;
  }
  if (loadShed && workerQueueFull()) {
    throw new Error(WORKER_QUEUE_FULL);
  }
  pendingWorkerRuns.push(entry);
  if (!queuedLeaseTimer) {
    queuedLeaseTimer = setInterval(
      () => void renewQueuedLeases(),
      QUEUED_LEASE_RENEW_INTERVAL_MS,
    );
    queuedLeaseTimer.unref();
  }
}

function startNextWorker(): void {
  const next = pendingWorkerRuns.shift();
  if (pendingWorkerRuns.length === 0 && queuedLeaseTimer) {
    clearInterval(queuedLeaseTimer);
    queuedLeaseTimer = undefined;
  }
  next?.[1]();
}
