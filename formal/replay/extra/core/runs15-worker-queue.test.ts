import { describe, expect, jest, spyOn, test } from "bun:test";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";

const {
  dispatchInProcessWorker,
  drainInProcessWorkers,
  WORKER_QUEUE_FULL,
  workerQueueFull,
} = await import("../../../../apps/core/src/harness/worker-queue.ts");

const RENEW_INTERVAL_MS = 5 * 60 * 1000;
const WORKER_SLOTS = 8;

function holdSlots(releases: Array<() => void>): void {
  for (let i = 0; i < WORKER_SLOTS; i += 1) {
    dispatchInProcessWorker(
      "test-worker",
      (): Promise<void> =>
        new Promise<void>((resolve): void => {
          releases.push(resolve);
        }),
    );
  }
}

describe("the in-process worker queue", (): void => {
  test("a lease renewal that throws is logged and the run still starts later", async (): Promise<void> => {
    const mutate = spyOn(runtime, "mutate").mockRejectedValue(
      new Error("convex down"),
    );
    const releases: Array<() => void> = [];
    const ran: string[] = [];
    jest.useFakeTimers();
    try {
      holdSlots(releases);
      dispatchInProcessWorker(
        "queued-worker",
        async (): Promise<void> => {
          ran.push("queued");
        },
        {
          conversationKey: "acct:a:agent:b:api:c",
          ownerEventId: "event-9",
          ownerGeneration: 3,
        },
      );
      jest.advanceTimersByTime(RENEW_INTERVAL_MS);
      for (let i = 0; i < 20; i += 1) await Promise.resolve();

      expect(mutate).toHaveBeenCalledTimes(1);
      for (const release of releases) release();
      await drainInProcessWorkers();
      expect(ran).toEqual(["queued"]);
    } finally {
      jest.useRealTimers();
      mutate.mockRestore();
    }
  });

  test("a full queue refuses another run", async (): Promise<void> => {
    const releases: Array<() => void> = [];
    holdSlots(releases);
    let accepted = 0;
    try {
      while (!workerQueueFull()) {
        dispatchInProcessWorker("filler", async (): Promise<void> => {});
        accepted += 1;
      }

      expect(accepted).toBeGreaterThan(0);
      expect((): ReturnType<typeof dispatchInProcessWorker> =>
        dispatchInProcessWorker("one-more", async (): Promise<void> => {}),
      ).toThrow(WORKER_QUEUE_FULL);
    } finally {
      for (const release of releases) release();
      await drainInProcessWorkers();
    }
  });
});
