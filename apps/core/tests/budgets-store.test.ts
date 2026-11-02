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

    // One write id across attempts: Convex applies it once even if only the response was lost.
    const write = {
      accountId: "acct_1",
      usage: { egressGb: 2 },
      writeId: expect.any(String),
    };
    expect(writes).toEqual([write, write]);
    expect((writes[0] as { writeId: string }).writeId).toBe(
      (writes[1] as { writeId: string }).writeId,
    );
  });

  it("names the usage's source when the caller knows it", async () => {
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_DEPLOY_KEY = "dev:test|key";
    const writes: unknown[] = [];
    const mutation = spyOn(
      ConvexHttpClient.prototype,
      "mutation",
    ).mockImplementation(async (_ref, ...args) => {
      writes.push(args[0]);

      return null;
    });

    try {
      await budgets.record("acct_1", { ingressGb: 1 }, { agentId: "agent_1" });
    } finally {
      mutation.mockRestore();
    }

    expect(writes).toEqual([
      {
        accountId: "acct_1",
        usage: { ingressGb: 1 },
        writeId: expect.any(String),
        source: { agentId: "agent_1" },
      },
    ]);
  });
});
