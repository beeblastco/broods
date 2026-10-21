/**
 * Drives a call whose waits run on a `jest.useFakeTimers()` clock. It yields
 * on microtasks only, so it fits stubs that answer in process: in bun 1.4.2 a
 * queued setImmediate can stall a fake clock. A microtask loop also starves
 * the test timeout, so the wait carries its own bound.
 */

import { jest } from "bun:test";

const HOPS_PER_STEP = 100;
const STEP_MS = 50;
// Twice the longest budget a caller waits out (the MicroVM mount hook's 30 s).
const MAX_FAKE_MS = 60_000;

// Lets the stubbed I/O answer, then moves the clock 50 ms, until `call`
// settles. Throws once a minute of fake time passes without that.
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
