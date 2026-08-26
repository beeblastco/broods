/**
 * Frame-order tests for the NATS publish path. The WebSocket stream was
 * observed delivering parts out of order (text-delta before text-start)
 * because each publish raced its own async ownership fence; these tests pin
 * the fix: fences run concurrently, sends land in call order.
 */

import { describe, expect, it } from "bun:test";
import {
  createOrderedFencedPublisher,
  type NatsPublisher,
} from "../src/shared/nats.ts";

function recordingPublisher(published: Array<Record<string, unknown>>): {
  publisher: NatsPublisher;
  closed: () => boolean;
} {
  let closed = false;

  return {
    publisher: {
      publish: async (data) => {
        published.push(data);
      },
      close: async () => {
        closed = true;
      },
    },
    closed: () => closed,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise: promise, resolve: resolve };
}

describe("createOrderedFencedPublisher", () => {
  it("keeps publish order when an early fence resolves late", async () => {
    const published: Array<Record<string, unknown>> = [];
    const { publisher } = recordingPublisher(published);
    // First fence is the slowest — exactly the race that reordered frames.
    const fences = [deferred(), deferred(), deferred()] as const;
    let fenceIndex = 0;
    const ordered = createOrderedFencedPublisher(publisher, () => {
      const fence = fences[fenceIndex as 0 | 1 | 2];
      fenceIndex++;

      return fence.promise;
    });

    const sends = [
      ordered.publish({ type: "text-start", id: "0" }),
      ordered.publish({ type: "text-delta", id: "0", text: "hi" }),
      ordered.publish({ type: "text-end", id: "0" }),
    ];
    // Later fences resolve before the first one.
    fences[2].resolve();
    fences[1].resolve();
    await Bun.sleep(1);
    expect(published).toEqual([]);
    fences[0].resolve();
    await Promise.all(sends);

    expect(published.map((part) => part.type)).toEqual([
      "text-start",
      "text-delta",
      "text-end",
    ]);
  });

  it("starts every fence immediately, not one at a time", async () => {
    const published: Array<Record<string, unknown>> = [];
    const { publisher } = recordingPublisher(published);
    let started = 0;
    const gate = deferred();
    const ordered = createOrderedFencedPublisher(publisher, () => {
      started++;

      return gate.promise;
    });

    const sends = [
      ordered.publish({ seq: 1 }),
      ordered.publish({ seq: 2 }),
      ordered.publish({ seq: 3 }),
    ];
    // All ownership checks are in flight before any publish completes —
    // serializing them would throttle token streaming to one RTT per chunk.
    expect(started).toBe(3);
    gate.resolve();
    await Promise.all(sends);
    expect(published.map((part) => part.seq)).toEqual([1, 2, 3]);
  });

  it("skips the chunk whose fence rejects and keeps publishing later ones", async () => {
    const published: Array<Record<string, unknown>> = [];
    const { publisher } = recordingPublisher(published);
    let call = 0;
    const ordered = createOrderedFencedPublisher(publisher, () => {
      call++;

      return call === 2
        ? Promise.reject(new Error("Stale conversation owner generation"))
        : Promise.resolve();
    });

    await ordered.publish({ seq: 1 });
    await expect(ordered.publish({ seq: 2 })).rejects.toThrow(
      "Stale conversation owner generation",
    );
    await ordered.publish({ seq: 3 });

    expect(published.map((part) => part.seq)).toEqual([1, 3]);
  });

  it("delegates close to the wrapped publisher", async () => {
    const published: Array<Record<string, unknown>> = [];
    const { publisher, closed } = recordingPublisher(published);
    const ordered = createOrderedFencedPublisher(publisher, () =>
      Promise.resolve(),
    );
    await ordered.close();
    expect(closed()).toBe(true);
  });
});
