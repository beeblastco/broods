import { describe, expect, it, mock, spyOn } from "bun:test";
import type { Session } from "../src/harness/session.ts";

type TerminalSession = Pick<
  Session,
  "releaseConversationLease" | "settleIngress"
>;

const { ownerCheckForStream, settleFailedIngressAndDrain } =
  await import("../src/harness/handler.ts");

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
  it("checks the first chunk, exact frames, and deltas once the window passes", async () => {
    const assertCurrentOwner = mock(async (): Promise<void> => {});
    const now = spyOn(performance, "now").mockReturnValue(500);
    try {
      const checkOwner = ownerCheckForStream({
        assertCurrentOwner: assertCurrentOwner,
      });

      // First chunk, even this early in the process's life.
      await checkOwner({ type: "text-delta" });
      expect(assertCurrentOwner).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_500);
      await checkOwner({ type: "text-delta" });
      expect(assertCurrentOwner).toHaveBeenCalledTimes(1);

      // Exact frames ignore the window, the timer heartbeat included.
      await checkOwner({ type: "done" });
      await checkOwner({ type: "waiting" });
      expect(assertCurrentOwner).toHaveBeenCalledTimes(3);

      // Still inside the window the `waiting` check restarted at 1500.
      now.mockReturnValue(3_400);
      await checkOwner({ type: "text-delta" });
      expect(assertCurrentOwner).toHaveBeenCalledTimes(3);

      now.mockReturnValue(3_500);
      await checkOwner({ type: "text-delta" });
      expect(assertCurrentOwner).toHaveBeenCalledTimes(4);
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
    },
  };
}
