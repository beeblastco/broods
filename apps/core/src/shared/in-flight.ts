import { toErrorMessage } from "./errors.ts";
import { logError } from "./log.ts";

const inFlight = new Set<Promise<void>>();

export async function drainInFlight(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled(inFlight);
  }
}

export function inFlightForTests(): ReadonlySet<Promise<void>> {
  return inFlight;
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
