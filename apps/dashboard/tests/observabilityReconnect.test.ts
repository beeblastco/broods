import { expect, test } from "bun:test";
import { reconnectDelay } from "../app/hooks/useObservabilityStream";

// The gateway blocks an address after GATEWAY_AUTH_FAILURES_PER_MINUTE (20) failed auths.
function redialsInFirstMinute(code: number): number {
  let elapsed = 0;
  let attempt = 0;
  for (;;) {
    const delay = reconnectDelay(code, attempt);
    if (delay === null || elapsed + delay > 60_000) return attempt;
    elapsed += delay;
    attempt += 1;
  }
}

test("a revoked stage session is not redialled", () => {
  expect(reconnectDelay(4401, 0)).toBeNull();
  expect(redialsInFirstMinute(4401)).toBe(0);
});

test("other closes back off to a minute, far under the gateway's auth failure limit", () => {
  expect(redialsInFirstMinute(1006)).toBe(4);
  expect(reconnectDelay(1006, 20)).toBe(60_000);
});
