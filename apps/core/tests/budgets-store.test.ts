/**
 * The Convex budget store's usage write: a failed write is retried rather
 * than dropped, since each one is money the platform already spent.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ConvexHttpClient } from "convex/browser";
import { budgets } from "../src/shared/convex/budgets.ts";

const savedEnv = { ...process.env };

afterEach(() => {
  process.env = { ...savedEnv };
});

describe("budgets.record", () => {
  it("retries a failed usage write until it lands", async () => {
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_DEPLOY_KEY = "dev:test|key";
    const writes: unknown[] = [];
    const mutation = spyOn(
      ConvexHttpClient.prototype,
      "mutation",
    ).mockImplementation(async (_ref, ...args) => {
      writes.push(args[0]);
      if (writes.length === 1) throw new Error("convex unavailable");

      return null;
    });

    try {
      await budgets.record("acct_1", { egressGb: 2 });
    } finally {
      mutation.mockRestore();
    }

    expect(writes).toEqual([
      { accountId: "acct_1", usage: { egressGb: 2 } },
      { accountId: "acct_1", usage: { egressGb: 2 } },
    ]);
  });
});
