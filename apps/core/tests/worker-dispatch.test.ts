/**
 * In-process worker dispatch tests.
 * Cover the container replacement for the Lambda Event self-invoke: capped
 * concurrency, FIFO queueing, failure swallowing, and shutdown draining.
 */

import { describe, expect, it } from "bun:test";

process.env.CONVERSATIONS_TABLE_NAME ??= "conversations";
process.env.PROCESSED_EVENTS_TABLE_NAME ??= "processed-events";
process.env.ASYNC_AGENT_RESULT_TABLE_NAME ??= "async-agent-result";
process.env.ASYNC_TOOL_RESULT_TABLE_NAME ??= "async-tool-result";

const { dispatchInProcessWorker, drainInProcessWorkers } =
  await import("../src/harness/handler.ts");

type WorkerPayload = Parameters<typeof dispatchInProcessWorker>[0];

function payload(id: number): WorkerPayload {
  return {
    kind: "direct-api-async-worker",
    event: { eventId: `evt-${id}` },
  } as unknown as WorkerPayload;
}

describe("in-process worker dispatch", () => {
  it("runs payloads with a synthesized invocation context", async () => {
    let seenContext: { requestId: string; deadlineMs: number } | undefined;
    dispatchInProcessWorker(payload(1), async (_payload, context) => {
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

    const run = (id: number) => async () => {
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
      dispatchInProcessWorker(payload(i), run(i));
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

  it("logs and swallows worker failures like a fire-and-forget invoke", async () => {
    // Must not reject or throw; the failure only surfaces through logError.
    dispatchInProcessWorker(payload(99), async () => {
      throw new Error("worker exploded");
    });
    await drainInProcessWorkers();
  });
});
