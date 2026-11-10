import { describe, expect, test } from "bun:test";

import { RateLimiter } from "../../../../apps/gateway/src/rate-limiter.ts";
import { normalizeBaseUrl } from "../../../../apps/gateway/src/utils.ts";

describe("RateLimiter.retryAfterSeconds", (): void => {
  test("is zero for a key never seen", (): void => {
    expect(new RateLimiter(2, 60_000).retryAfterSeconds("nobody")).toBe(0);
  });
});

describe("normalizeBaseUrl", (): void => {
  test("refuses an empty value", (): void => {
    expect((): string => normalizeBaseUrl("  /  ")).toThrow(
      "Gateway requires BROODS_CORE_URL",
    );
  });
});
