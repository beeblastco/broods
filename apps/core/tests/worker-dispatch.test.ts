import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  spyOn,
} from "bun:test";
import * as harness from "../src/harness/harness.ts";
import * as ingress from "../src/harness/ingress.ts";
import { Session } from "../src/harness/session.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import { getStorage, resetStorageForTests } from "../src/shared/storage.ts";
import { coreRequest } from "./helpers/http.ts";

const { handler } = await import("../src/harness/handler.ts");
const { dispatchInProcessWorker, drainInProcessWorkers } =
  await import("../src/harness/worker-queue.ts");
const QUEUED_LEASE_RENEW_INTERVAL_MS = 5 * 60 * 1000;
const WORKER_SLOTS = 8;
const MAX_PENDING_WORKER_RUNS = 1000;

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

  it("aborts an overrunning run when it reclaims the slot", async () => {
    const releases: (() => void)[] = [];
    let signal: AbortSignal | undefined;
    jest.useFakeTimers();
    try {
      dispatchInProcessWorker(
        "test-worker",
        (context): Promise<void> =>
          new Promise<void>((resolve) => {
            signal = context.abortSignal;
            releases.push(resolve);
          }),
      );
      jest.advanceTimersByTime(10 * 60 * 1000);
      expect(signal?.aborted).toBe(false);
      jest.advanceTimersByTime(5_000);
      expect(signal?.aborted).toBe(true);
      expect((signal?.reason as Error).message).toBe(
        "I ran out of time on this turn.",
      );
      await drainInProcessWorkers();
    } finally {
      jest.useRealTimers();
      for (const release of releases) release();
    }
  });

  it("hands a yielding run's slot to the queued run and resumes it next", async (): Promise<void> => {
    const releases: (() => void)[] = [];
    const started: string[] = [];
    const blocked = (): Promise<void> =>
      new Promise<void>((resolve): void => {
        releases.push(resolve);
      });
    let firstDeadline = 0;
    let resumedDeadline = 0;
    dispatchInProcessWorker("test-worker", async (context): Promise<void> => {
      started.push("yielder");
      firstDeadline = context.deadlineMs;
      await blocked();
      await context.yieldSlot!(undefined);
      resumedDeadline = context.deadlineMs;
    });
    for (let i = 0; i < 7; i += 1) {
      dispatchInProcessWorker("test-worker", async (): Promise<void> => {
        started.push(`busy-${i}`);
        await blocked();
      });
    }
    dispatchInProcessWorker("test-worker", async (): Promise<void> => {
      started.push("queued");
      await blocked();
    });
    await flushMicrotasks();
    expect(started).not.toContain("queued");

    // The yield frees the slot for the queued run; the yielder waits its turn.
    await Bun.sleep(2);
    releases.shift()!();
    await flushMicrotasks();
    expect(started).toContain("queued");
    expect(resumedDeadline).toBe(0);

    releases.shift()!();
    await flushMicrotasks();
    expect(resumedDeadline).toBeGreaterThan(firstDeadline);

    while (releases.length > 0) releases.shift()!();
    await drainInProcessWorkers();
  });

  it("logs and swallows worker failures like a fire-and-forget invoke", async () => {
    // Must not reject or throw; the failure only surfaces through logError.
    dispatchInProcessWorker("test-worker", async () => {
      throw new Error("worker exploded");
    });
    await drainInProcessWorkers();
  });
});

describe("streamed runs", (): void => {
  let settle: ReturnType<typeof spyOn<typeof ingress, "settleIngress">>;
  let modelPasses: number;
  // Turns prepared: loading history and storing the new input.
  let prepared: number;
  let releases: (() => void)[];

  beforeEach((): void => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    modelPasses = 0;
    prepared = 0;
    releases = [];
    const storage = getStorage();
    spyOn(storage.accounts, "getById").mockResolvedValue({
      accountId: "acct_1",
      username: "ada",
      secretHash: "hash",
      status: "active",
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    spyOn(storage.agents, "getById").mockResolvedValue({
      accountId: "acct_1",
      agentId: "agent_1",
      name: "agent",
      config: {},
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    spyOn(storage.budgets, "get").mockResolvedValue(null);
    spyOn(runtime, "mutate").mockResolvedValue(null);
    spyOn(runtime, "query").mockResolvedValue(null);
    spyOn(ingress, "acceptIngress").mockResolvedValue({
      outcome: "owner",
      ownerGeneration: 1,
    });
    settle = spyOn(ingress, "settleIngress").mockResolvedValue(1);
    spyOn(Session.prototype, "assertCurrentOwner").mockResolvedValue();
    spyOn(Session.prototype, "createTurnContext").mockImplementation(
      async (): ReturnType<Session["createTurnContext"]> => {
        prepared += 1;

        return {
          messages: [{ role: "user", content: "hi" }],
          system: [],
          ephemeralSystem: [],
          systemContextSnapshot: { cursor: null, messages: [] },
        };
      },
    );
    // The pass ends before any model call; only when it starts matters.
    spyOn(harness, "runAgentLoop").mockImplementation(
      async (): Promise<never> => {
        modelPasses += 1;
        throw new Error("model pass reached");
      },
    );
    for (let slot = 0; slot < WORKER_SLOTS; slot += 1) {
      dispatchInProcessWorker(
        "busy",
        (): Promise<void> =>
          new Promise<void>((resolve): void => {
            releases.push(resolve);
          }),
      );
    }
  });

  afterEach(async (): Promise<void> => {
    for (const release of releases) release();
    await drainInProcessWorkers();
    mock.restore();
    resetStorageForTests();
    delete process.env.SERVICE_AUTH_SECRET;
  });

  function streamedRun(index: number): Promise<Response> {
    return handler(
      coreRequest(
        "POST",
        "/v1/runs",
        {
          authorization: "Bearer service-secret",
          "x-account-id": "acct_1",
        },
        {
          agentId: "agent_1",
          eventId: `event-${index}`,
          conversationKey: `conversation-${index}`,
          events: [{ role: "user", content: "hi" }],
        },
      ),
    );
  }

  function settles(): unknown[] {
    return settle.mock.calls.map(([settlement]): unknown => settlement);
  }

  it("waits for a worker slot like every other run, streaming meanwhile", async (): Promise<void> => {
    const responses = await Promise.all([streamedRun(1), streamedRun(2)]);
    await Bun.sleep(20);

    // The streams are open, but no model pass starts while every slot is busy.
    expect(responses.map((response): number => response.status)).toEqual([
      200, 200,
    ]);
    expect(modelPasses).toBe(0);
    expect(prepared).toBe(0);

    for (const release of releases.splice(0)) release();
    const bodies = await Promise.all(
      responses.map((response): Promise<string> => response.text()),
    );
    expect(modelPasses).toBe(2);
    for (const body of bodies) expect(body).toContain("model pass reached");
  });

  it("starts nothing for a client that left while it waited", async (): Promise<void> => {
    const response = await streamedRun(1);
    await response.body!.cancel();

    for (const release of releases.splice(0)) release();
    await drainInProcessWorkers();
    expect(modelPasses).toBe(0);
    expect(prepared).toBe(0);
    expect(settles()).toEqual([
      expect.objectContaining({ status: "failed", ownerGeneration: 1 }),
    ]);
  });

  it("answers 503 and fails the run when the worker queue is full", async (): Promise<void> => {
    for (let index = 0; index < MAX_PENDING_WORKER_RUNS; index += 1) {
      dispatchInProcessWorker("queued", async (): Promise<void> => {});
    }

    const response = await streamedRun(1);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.text()).toContain("In-process worker queue is full");
    expect(modelPasses).toBe(0);
    expect(prepared).toBe(0);
    expect(settles()).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "In-process worker queue is full",
      }),
    ]);
  });
});
