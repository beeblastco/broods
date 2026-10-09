import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";

const { startIngressRecovery, stopIngressRecovery } =
  await import("../src/harness/ingress-recovery.ts");

describe("queued ingress recovery", () => {
  afterEach(() => {
    stopIngressRecovery();
  });

  it("walks every page of queued conversations in one sweep", async () => {
    const pages = ["acct:a:agent:b:api:m", "acct:a:agent:b:api:z", null];
    const mutate = spyOn(runtime, "mutate").mockImplementation(
      async <T>(): Promise<T> =>
        ({ recovered: [], continueAfter: pages.shift() ?? null }) as T,
    );
    try {
      startIngressRecovery();
      for (let i = 0; i < 100 && mutate.mock.calls.length < 3; i += 1) {
        await Bun.sleep(1);
      }

      expect(mutate.mock.calls.map((call) => call[1])).toEqual([
        { leaseTtlMs: 15 * 60 * 1000 },
        {
          leaseTtlMs: 15 * 60 * 1000,
          afterConversationKey: "acct:a:agent:b:api:m",
        },
        {
          leaseTtlMs: 15 * 60 * 1000,
          afterConversationKey: "acct:a:agent:b:api:z",
        },
      ]);
    } finally {
      mutate.mockRestore();
    }
  });

  it("resumes the next sweep where a capped one stopped", async () => {
    let page = 0;
    const mutate = spyOn(runtime, "mutate").mockImplementation(
      async <T>(): Promise<T> => {
        page += 1;

        return { recovered: [], continueAfter: `key-${page}` } as T;
      },
    );
    try {
      startIngressRecovery();
      for (let i = 0; i < 200 && mutate.mock.calls.length < 50; i += 1) {
        await Bun.sleep(1);
      }
      await Bun.sleep(5);
      expect(mutate).toHaveBeenCalledTimes(50);

      stopIngressRecovery();
      startIngressRecovery();
      for (let i = 0; i < 200 && mutate.mock.calls.length < 51; i += 1) {
        await Bun.sleep(1);
      }

      expect(mutate.mock.calls[50]?.[1]).toEqual({
        leaseTtlMs: 15 * 60 * 1000,
        afterConversationKey: "key-50",
      });
    } finally {
      mutate.mockRestore();
    }
  });
});
