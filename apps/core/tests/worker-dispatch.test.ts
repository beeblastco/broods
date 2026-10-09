import { describe, expect, it, jest, spyOn } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";

const { dispatchInProcessWorker, drainInProcessWorkers } =
  await import("../src/harness/handler.ts");
const QUEUED_LEASE_RENEW_INTERVAL_MS = 5 * 60 * 1000;

/** Lets settled renewals run their continuations; fake timers also fake Bun.sleep. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe("in-process worker dispatch", () => {
  it("runs payloads with a synthesized invocation context", async () => {
    let seenContext: { requestId: string; deadlineMs: number } | undefined;
    dispatchInProcessWorker("test-worker", async (context) => {
      seenContext = context;
    });
    await drainInProcessWorkers();

    expect(seenContext?.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(seenContext!.deadlineMs).toBeGreaterThan(Date.now());
  });

  it("caps concurrency at the worker limit and drains the FIFO queue", async () => {
    const releases: (() => void)[] = [];
    const started: number[] = [];
    let active = 0;
    let peakActive = 0;

    const run =
      (id: number): (() => Promise<void>) =>
      async () => {
        started.push(id);
        active += 1;
        peakActive = Math.max(peakActive, active);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        active -= 1;
      };

    const waitForStarted = async (count: number): Promise<void> => {
      for (let i = 0; i < 200 && started.length < count; i += 1) {
        await Bun.sleep(1);
      }
    };

    // Default cap is 8; dispatch 10 so two must queue.
    for (let i = 0; i < 10; i += 1) {
      dispatchInProcessWorker("test-worker", run(i));
    }
    await waitForStarted(8);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    // Finishing one worker pulls the next queued payload, in FIFO order.
    releases.shift()!();
    await waitForStarted(9);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    while (releases.length > 0) {
      releases.shift()!();
      await waitForStarted(Math.min(10, started.length + 1));
    }
    await drainInProcessWorkers();
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peakActive).toBeLessThanOrEqual(8);
  });

  it("renews a queued run's lease until a slot starts it, and only then", async () => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue("renewed");
    const releases: (() => void)[] = [];
    const lease = {
      conversationKey: "acct:a:agent:b:api:c",
      ownerEventId: "event-9",
      ownerGeneration: 3,
    };
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 8; i += 1) {
        dispatchInProcessWorker(
          "test-worker",
          (): Promise<void> =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        );
      }
      dispatchInProcessWorker(
        "test-worker",
        async (): Promise<void> => {},
        lease,
      );
      // A short wait costs no Convex call.
      jest.advanceTimersByTime(QUEUED_LEASE_RENEW_INTERVAL_MS - 1);
      expect(mutate).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(mutate.mock.calls).toEqual([
        ["renewIngressOwner", { ...lease, leaseTtlMs: 15 * 60 * 1000 }],
      ]);

      for (const release of releases) release();
      await drainInProcessWorkers();
      jest.advanceTimersByTime(QUEUED_LEASE_RENEW_INTERVAL_MS * 2);
      expect(mutate).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      mutate.mockRestore();
    }
  });

  it("stops renewing a queued lease that came back stale", async () => {
    const mutate = spyOn(runtime, "mutate").mockResolvedValue("stale");
    const releases: (() => void)[] = [];
    const lease = {
      conversationKey: "acct:a:agent:b:api:c",
      ownerEventId: "event-9",
      ownerGeneration: 3,
    };
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 8; i += 1) {
        dispatchInProcessWorker(
          "test-worker",
          (): Promise<void> =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        );
      }
      dispatchInProcessWorker(
        "test-worker",
        async (): Promise<void> => {},
        lease,
      );
      jest.advanceTimersByTime(QUEUED_LEASE_RENEW_INTERVAL_MS);
      await flushMicrotasks();
      jest.advanceTimersByTime(QUEUED_LEASE_RENEW_INTERVAL_MS * 2);
      await flushMicrotasks();

      expect(mutate).toHaveBeenCalledTimes(1);
      for (const release of releases) release();
      await drainInProcessWorkers();
    } finally {
      jest.useRealTimers();
      mutate.mockRestore();
    }
  });

  it("renews a full queue's leases a few at a time", async () => {
    const pending: ((value: "renewed") => void)[] = [];
    const mutate = spyOn(runtime, "mutate").mockImplementation(
      <T>(): Promise<T> =>
        new Promise<T>((resolve) => {
          pending.push((value) => resolve(value as T));
        }),
    );
    const releases: (() => void)[] = [];
    jest.useFakeTimers();
    try {
      for (let i = 0; i < 8; i += 1) {
        dispatchInProcessWorker(
          "test-worker",
          (): Promise<void> =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        );
      }
      for (let i = 0; i < 20; i += 1) {
        dispatchInProcessWorker("test-worker", async (): Promise<void> => {}, {
          conversationKey: `acct:a:agent:b:api:${i}`,
          ownerEventId: `event-${i}`,
          ownerGeneration: 1,
        });
      }
      jest.advanceTimersByTime(QUEUED_LEASE_RENEW_INTERVAL_MS);
      expect(mutate).toHaveBeenCalledTimes(16);

      // A sweep still in flight is not started over by the next tick.
      jest.advanceTimersByTime(QUEUED_LEASE_RENEW_INTERVAL_MS);
      expect(mutate).toHaveBeenCalledTimes(16);

      for (const resolve of pending.splice(0)) resolve("renewed");
      await flushMicrotasks();
      expect(mutate).toHaveBeenCalledTimes(20);
      for (const resolve of pending.splice(0)) resolve("renewed");
      await flushMicrotasks();

      for (const release of releases) release();
      await drainInProcessWorkers();
    } finally {
      jest.useRealTimers();
      mutate.mockRestore();
    }
  });

  it("logs and swallows worker failures like a fire-and-forget invoke", async () => {
    // Must not reject or throw; the failure only surfaces through logError.
    dispatchInProcessWorker("test-worker", async () => {
      throw new Error("worker exploded");
    });
    await drainInProcessWorkers();
  });
});
