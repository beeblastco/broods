/**
 * Post-response work the process must finish before it exits. `waitUntil` is
 * what `RequestContext.waitUntil` hands every handler, and shutdown drains the
 * set before `process.exit`. Lives outside server.ts so runtime code that never
 * sees a request context (a sandbox teardown) can register work here without
 * importing the entry point.
 */

import { toErrorMessage } from "./errors.ts";
import { logError } from "./log.ts";

const inFlight = new Set<Promise<void>>();

export async function drainInFlight(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight);
  }
}

export function waitUntil(promise: Promise<unknown>): void {
  const tracked = Promise.resolve(promise)
    .then((): undefined => undefined)
    .catch((error: unknown): void => {
      logError("Post-response work failed", { error: toErrorMessage(error) });
    })
    .finally((): void => {
      inFlight.delete(tracked);
    });
  inFlight.add(tracked);
}
