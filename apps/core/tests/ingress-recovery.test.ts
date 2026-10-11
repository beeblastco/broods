import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  createSubagentTaskId,
  scopedDirectConversationKey,
  scopedDirectEventId,
  subagentTaskNonce,
} from "../src/shared/runtime-keys.ts";
import { setStorageForTests } from "../src/shared/storage.ts";

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

  it("resumes the parent with late subagent results a restart lost", async () => {
    const parentEventId = scopedDirectEventId(
      "account_1",
      "agent_parent",
      "event_parent",
    );
    const parentKey = scopedDirectConversationKey(
      "account_1",
      "agent_parent",
      "chat",
    );
    // One child finished but its run died before telling the parent; the
    // other died with the pod while it ran, long past its budget, so its row
    // is failed and the next sweep tells the parent.
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const rows = ["finished", "killed"].map((name) => {
      const taskId = createSubagentTaskId(parentEventId);

      return {
        accountId: "account_1",
        eventId: scopedDirectEventId("account_1", "agent_child", taskId),
        conversationKey: scopedDirectConversationKey(
          "account_1",
          "agent_child",
          `subagent-${name}`,
        ),
        subagent: {
          taskId: taskId,
          agentId: "agent_child",
          conversationKey: `subagent-${name}`,
          parentConversationKey: parentKey,
          parentDelivery: { kind: "async" },
        },
        observed: false,
        status: name === "finished" ? "completed" : "processing",
        ...(name === "finished" ? { response: "the late answer" } : {}),
        createdAt: longAgo,
        updatedAt: longAgo,
        expiresAt: Date.now() + 60_000,
      };
    });
    setStorageForTests({
      agents: {
        getById: async () => ({ agentId: "agent_parent", config: {} }),
      },
      agentDeployments: {},
    } as never);
    const query = spyOn(runtime, "query").mockImplementation(
      async <T>(name: string): Promise<T> =>
        (name === "listUnobservedAsyncAgentResults" ? rows : null) as T,
    );
    const admitted: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    const mutate = spyOn(runtime, "mutate").mockImplementation(
      async <T>(name: string, args: Record<string, unknown>): Promise<T> => {
        if (name === "acceptIngress") {
          admitted.push(args);

          return { outcome: "queued" } as T;
        }
        if (name === "updateAsyncAgentResult") failed.push(args);

        return { recovered: [], continueAfter: null } as T;
      },
    );
    try {
      startIngressRecovery();
      for (
        let i = 0;
        i < 200 && (admitted.length < 1 || failed.length < 1);
        i += 1
      ) {
        await Bun.sleep(1);
      }

      expect(failed).toEqual([
        expect.objectContaining({
          eventId: rows[1]!.eventId,
          status: "failed",
          error: expect.stringContaining("restarted"),
        }),
      ]);
      expect(admitted).toEqual([
        expect.objectContaining({
          eventId: `${parentEventId}:async-subagent:${subagentTaskNonce(rows[0]!.subagent.taskId)}`,
          conversationKey: parentKey,
          requestedMode: "followup",
          resultEventId: rows[0]!.eventId,
        }),
      ]);
      expect(JSON.stringify(admitted[0]?.events)).toContain("the late answer");
    } finally {
      query.mockRestore();
      mutate.mockRestore();
      setStorageForTests(null);
    }
  });
});
