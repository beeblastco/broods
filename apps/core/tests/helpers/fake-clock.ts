// Microtask hops only: in bun 1.4.2 a queued setImmediate can stall a fake clock. The loop
// also starves the test timeout, hence its own MAX_FAKE_MS bound.

import { jest } from "bun:test";

const HOPS_PER_STEP = 100;
const STEP_MS = 50;
// Twice the longest budget a caller waits out (the MicroVM mount hook's 30 s).
const MAX_FAKE_MS = 60_000;

export async function settleOnFakeClock<T>(call: Promise<T>): Promise<T> {
  let settled = false;
  call.then(
    (): void => {
      settled = true;
    },
    (): void => {
      settled = true;
    },
  );
  for (let elapsedMs = 0; !settled; elapsedMs += STEP_MS) {
    if (elapsedMs >= MAX_FAKE_MS) {
      throw new Error(
        `call still pending after ${MAX_FAKE_MS} ms of fake time`,
      );
    }
    for (let hop = 0; hop < HOPS_PER_STEP; hop += 1) await Promise.resolve();
    jest.advanceTimersByTime(STEP_MS);
  }

  return call;
}
