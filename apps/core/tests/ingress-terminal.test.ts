import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { OWNER_CHECK_INTERVAL_MS, Session } from "../src/harness/session.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

type TerminalSession = Pick<
  Session,
  "releaseConversationLease" | "settleIngress"
>;

const { ownerCheckForStream, settleFailedIngressAndDrain } =
  await import("../src/harness/handler.ts");
const originalMutate = runtime.mutate.bind(runtime);
const originalQuery = runtime.query.bind(runtime);

describe("terminal ingress draining", () => {
  it("keeps the lease transferred when queued work is dispatched", async () => {
    const actions: string[] = [];

    const transferred = await settleFailedIngressAndDrain(
      terminalSession(actions),
      "stream failed",
      async () => {
        actions.push("dispatch");

        return true;
      },
    );

    expect(transferred).toBe(true);
    expect(actions).toEqual(["settle:failed:stream failed", "dispatch"]);
  });

  it("releases the lease when the queue has no further work", async () => {
    const actions: string[] = [];

    const transferred = await settleFailedIngressAndDrain(
      terminalSession(actions),
      "stream failed",
      async () => {
        actions.push("dispatch");

        return false;
      },
    );

    expect(transferred).toBe(false);
    expect(actions).toEqual([
      "settle:failed:stream failed",
      "dispatch",
      "release",
    ]);
  });

  it("releases the lease when queued-work dispatch fails", async () => {
    const actions: string[] = [];

    const transferred = await settleFailedIngressAndDrain(
      terminalSession(actions),
      "stream failed",
      async () => {
        actions.push("dispatch");
        throw new Error("dispatch failed");
      },
    );

    expect(transferred).toBe(false);
    expect(actions).toEqual([
      "settle:failed:stream failed",
      "dispatch",
      "release",
    ]);
  });

  it("still dispatches when the terminal settlement fails", async () => {
    const actions: string[] = [];

    const transferred = await settleFailedIngressAndDrain(
      {
        releaseConversationLease: async () => {
          actions.push("release");
        },
        settleIngress: async () => {
          actions.push("settle:threw");
          throw new Error("settle failed");
        },
      },
      "stream failed",
      async () => {
        actions.push("dispatch");

        return true;
      },
    );

    expect(transferred).toBe(true);
    expect(actions).toEqual(["settle:threw", "dispatch"]);
  });
});

describe("stream ownership check", () => {
  afterEach(() => {
    runtime.mutate = originalMutate;
    runtime.query = originalQuery;
  });

  it("skips the read right after a fenced write, checks exact frames, and reads again after the interval", async () => {
    const reads = mock(async (): Promise<boolean> => true);
    runtime.query = reads as unknown as typeof runtime.query;
    runtime.mutate = (async (): Promise<null> =>
      null) as unknown as typeof runtime.mutate;
    const now = spyOn(performance, "now").mockReturnValue(500);
    try {
      const session = new Session({
        eventId: "owner",
        conversationKey: "acct:a:agent:b:api:c",
        ownerGeneration: 1,
      });
      const checkOwner = ownerCheckForStream(session);

      // No proof yet: the first chunk reads, even this early in the process.
      await checkOwner({ type: "text-delta" });
      expect(reads).toHaveBeenCalledTimes(1);

      // A fenced append at 5000 answers the chunk at 6000.
      now.mockReturnValue(5_000);
      await session.persistModelMessages([{ role: "user", content: "hi" }]);
      now.mockReturnValue(6_000);
      await checkOwner({ type: "text-delta" });
      expect(reads).toHaveBeenCalledTimes(1);

      // Exact frames ignore any proof, the timer heartbeat included.
      await checkOwner({ type: "done" });
      await checkOwner({ type: "waiting" });
      expect(reads).toHaveBeenCalledTimes(3);

      // That read at 6000 is a proof until the interval passes.
      now.mockReturnValue(6_000 + OWNER_CHECK_INTERVAL_MS - 1);
      await checkOwner({ type: "text-delta" });
      expect(reads).toHaveBeenCalledTimes(3);
      now.mockReturnValue(6_000 + OWNER_CHECK_INTERVAL_MS);
      await checkOwner({ type: "text-delta" });
      expect(reads).toHaveBeenCalledTimes(4);

      // Once the lease is handed on, no earlier proof counts.
      await session.takeNextIngress();
      await checkOwner({ type: "text-delta" });
      expect(reads).toHaveBeenCalledTimes(5);
    } finally {
      now.mockRestore();
    }
  });
});

function terminalSession(actions: string[]): TerminalSession {
  return {
    releaseConversationLease: async () => {
      actions.push("release");
    },
    settleIngress: async (status, options) => {
      actions.push(`settle:${status}:${options?.error}`);

      return true;
    },
  };
}
