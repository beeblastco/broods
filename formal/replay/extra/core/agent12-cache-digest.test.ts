import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { cacheDigest } from "../../../../apps/core/src/shared/cache-digest.ts";

describe("cacheDigest", (): void => {
  test("is a stable hex digest of the value within one process", (): void => {
    const first = cacheDigest("token-a");

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheDigest("token-a")).toBe(first);
  });

  test("tells different values apart and never echoes the value", (): void => {
    const digests = new Set(
      ["", "a", "b", "token-a", "token-b"].map(cacheDigest),
    );

    expect(digests.size).toBe(5);
    expect(
      [...digests].some((digest): boolean => digest.includes("token")),
    ).toBe(false);
  });

  test("is keyed per process, so it is not a plain HMAC under a guessable key", (): void => {
    const guessed = createHmac("sha256", "").update("token-a").digest("hex");

    expect(cacheDigest("token-a")).not.toBe(guessed);
  });
});
