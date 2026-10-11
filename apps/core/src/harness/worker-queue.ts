/**
 * The pod's in-process worker pool: every agent run takes a slot here, or
 * waits FIFO with its conversation lease renewed until one frees. What a run
 * does once it has its slot stays with the handler.
 */

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
// A queued run holds its lease from admission, so the queue renews it well
// inside the TTL until a slot starts the run.
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
// Places `withQueuePlace` holds for requests still being admitted.
let heldQueuePlaces = 0;
const queuePlace = new AsyncLocalStorage<{ held: boolean }>();
let queuedLeaseTimer: ReturnType<typeof setInterval> | undefined;
let renewingQueuedLeases = false;

type InProcessWorkerRun = (context: RequestContext) => Promise<unknown>;

/**
 * Runs one agent turn on the pod's worker pool, or queues it FIFO while every
 * slot is busy. Every background run goes through here, channel turns
 * included, so MAX_INPROCESS_WORKERS bounds what the pod runs at once. A run
 * near its deadline calls `context.yieldSlot` to go to the back of the queue
 * and carry on with a fresh budget, up to MAX_RUN_SLOTS slots.
 * @param kind a label for logs
 * @param lease the conversation lease the run already holds, renewed while it waits
 */
export function dispatchInProcessWorker(
  kind: string,
  run: InProcessWorkerRun,
  lease?: LiveOwner,
): void {
  const runAbort = new AbortController();
  let slotsUsed = 0;
  let releaseSlot: (() => void) | undefined;
  // Settles the run's tracked promise on an overrun, so a stuck run does not
  // hold up the shutdown drain.
  let abandon: (() => void) | undefined;
  const context: RequestContext = {
    requestId: crypto.randomUUID(),
    deadlineMs: Date.now(),
    // Workers run detached; they never emit an HTTP response, so there is no
    // post-response tail to defer.
    waitUntil: () => {},
    abortSignal: runAbort.signal,
  };
  const takeSlot = (): void => {
    activeInProcessWorkers += 1;
    slotsUsed += 1;
    context.deadlineMs = Date.now() + WORKER_TIMEOUT_BUDGET_MS;
    if (slotsUsed >= MAX_RUN_SLOTS) delete context.yieldSlot;
    // A few stuck workers would otherwise pin every slot for every tenant on
    // the pod. An overrun frees the slot and aborts the run, so the pod never
    // runs more than MAX_INPROCESS_WORKERS model passes at once.
    const slotTimer = setTimeout((): void => {
      logError("In-process worker exceeded deadline; reclaiming slot", {
        kind: kind,
        budgetMs: WORKER_TIMEOUT_BUDGET_MS,
      });
      // The reason is what the chat shows; the log line above stays technical.
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
    // No budget while queued: a coordinator reading the old deadline would
    // take the parent for out of time.
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
  // A run its request held a place for takes that place and is never shed.
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

/**
 * Holds one queue place while `admit` counts and records a run, so concurrent
 * requests can never admit more runs than the queue takes. The first dispatch
 * inside `admit` takes the place and is never shed; a place no run took is
 * given back. Undefined, with nothing called, when the queue is full.
 */
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

/** Awaited by the container bootstrap on shutdown so queued work is not lost. */
export async function drainInProcessWorkers(): Promise<void> {
  while (inProcessWorkers.size > 0) {
    await Promise.allSettled(inProcessWorkers);
  }
}

/**
 * The queue's timer: renews every waiting run's lease, so a long wait does not
 * hand its conversation to `maintain`. A few renewals at a time, so a full
 * queue does not fire a thousand mutations at once, and one sweep at a time. A
 * lease that comes back stale or stopped is no longer renewed: the run finds
 * that out on its own first renewal once a slot starts it.
 */
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

/** True when a new run would neither start nor fit in the queue. */
export function workerQueueFull(): boolean {
  return (
    activeInProcessWorkers + pendingWorkerRuns.length + heldQueuePlaces >=
    MAX_INPROCESS_WORKERS + MAX_PENDING_WORKER_RUNS
  );
}

/** Starts a worker now when a slot is free, else queues it FIFO. */
function enqueueWorker(entry: PendingWorkerRun, loadShed = true): void {
  if (activeInProcessWorkers < MAX_INPROCESS_WORKERS) {
    entry[1]();

    return;
  }
  if (loadShed && workerQueueFull()) {
    // Load-shed: the awaiting caller surfaces the error instead of the queue
    // growing without bound.
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

/** Hands a freed slot to the oldest queued worker. */
function startNextWorker(): void {
  const next = pendingWorkerRuns.shift();
  if (pendingWorkerRuns.length === 0 && queuedLeaseTimer) {
    clearInterval(queuedLeaseTimer);
    queuedLeaseTimer = undefined;
  }
  next?.[1]();
}
