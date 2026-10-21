import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as asyncAgentResults from "../src/harness/async-agent-result.ts";
import type { AsyncAgentResultRecord } from "../src/harness/async-agent-result.ts";
import * as asyncToolResults from "../src/harness/async-tool-result.ts";
import type { AsyncToolResultRecord } from "../src/harness/async-tool-result.ts";
import * as handler from "../src/harness/handler.ts";
import * as ingress from "../src/harness/ingress.ts";
import type {
  IngressAdmission,
  IngressCandidate,
} from "../src/harness/ingress.ts";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  createSubagentTaskId,
  scopedDirectConversationKey,
  scopedDirectEventId,
  subagentTaskNonce,
} from "../src/shared/runtime-keys.ts";

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

  it("still resumes lost subagent and async tool results when the queue pass fails", async (): Promise<void> => {
    const queued = spyOn(ingress, "recoverQueuedIngress").mockRejectedValue(
      new Error("convex down"),
    );
    const listed: string[] = [];
    const pages = spyOn(
      asyncAgentResults,
      "listOwedAsyncAgentResults",
    ).mockImplementation(
      async (): Promise<{
        page: AsyncAgentResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => {
        listed.push("subagent");

        return { page: [], cursor: "end", isDone: true };
      },
    );
    const toolPages = spyOn(
      asyncToolResults,
      "listOwedAsyncToolResults",
    ).mockImplementation(
      async (): Promise<{
        page: AsyncToolResultRecord[];
        cursor: string;
        isDone: boolean;
      }> => {
        listed.push("tool");

        return { page: [], cursor: "end", isDone: true };
      },
    );
    // One list a window: detached and pending subagent rows in completed,
    // failed and processing; then detached and pending tool rows in
    // completed and failed.
    const windows = 6;
    const toolWindows = 4;
    try {
      startIngressRecovery();
      for (
        let i = 0;
        i < 100 && listed.length < windows + toolWindows;
        i += 1
      ) {
        await Bun.sleep(1);
      }

      expect(pages).toHaveBeenCalledTimes(windows);
      expect(toolPages).toHaveBeenCalledTimes(toolWindows);
      // The subagent pass runs first, whole.
      expect(listed.indexOf("tool")).toBe(windows);
    } finally {
      queued.mockRestore();
      pages.mockRestore();
      toolPages.mockRestore();
    }
  });

  it("resumes conversations with async tool results a restart lost, after the subagent pass", async (): Promise<void> => {
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const row: AsyncToolResultRecord = {
      resultId: "async_tool_lost",
      parentEventId: scopedDirectEventId("account_1", "agent_1", "event_1"),
      conversationKey: scopedDirectConversationKey(
        "account_1",
        "agent_1",
        "chat",
      ),
      toolName: "lookup",
      toolCallId: "call-1",
      input: {},
      status: "completed",
      response: "the late answer",
      handback: "detached",
      createdAt: longAgo,
      updatedAt: longAgo,
      expiresAt: Date.now() + 60_000,
    };
    const spies = [
      spyOn(ingress, "recoverQueuedIngress").mockResolvedValue({
        recovered: [],
        continueAfter: null,
      }),
      spyOn(asyncAgentResults, "listOwedAsyncAgentResults").mockResolvedValue({
        page: [],
        cursor: "end",
        isDone: true,
      }),
      spyOn(asyncToolResults, "listOwedAsyncToolResults").mockImplementation(
        async (options: {
          handback: string;
          status: string;
        }): Promise<{
          page: AsyncToolResultRecord[];
          cursor: string;
          isDone: boolean;
        }> => ({
          page:
            options.handback === row.handback && options.status === row.status
              ? [row]
              : [],
          cursor: "end",
          isDone: true,
        }),
      ),
    ];
    const resumed = spyOn(
      handler,
      "continueAfterAsyncToolSettlement",
    ).mockResolvedValue({
      kind: "ready",
      admission: "queued",
      invoked: false,
      publicEventId: "async-tools-async_tool_lost",
    });
    try {
      startIngressRecovery();
      for (let i = 0; i < 200 && resumed.mock.calls.length < 1; i += 1) {
        await Bun.sleep(1);
      }

      expect(resumed.mock.calls).toEqual([[row]]);
    } finally {
      for (const spy of spies) spy.mockRestore();
      resumed.mockRestore();
    }
  });

  it("resumes the parent with late subagent results a restart lost", async (): Promise<void> => {
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
    const taskIds = [
      createSubagentTaskId(parentEventId),
      createSubagentTaskId(parentEventId),
    ];
    const rows = ["finished", "killed"].map(
      (name, index): AsyncAgentResultRecord => ({
        accountId: "account_1",
        eventId: scopedDirectEventId(
          "account_1",
          "agent_child",
          taskIds[index]!,
        ),
        conversationKey: scopedDirectConversationKey(
          "account_1",
          "agent_child",
          `subagent-${name}`,
        ),
        subagent: {
          parentConversationKey: parentKey,
          parentDelivery: { kind: "async" },
        },
        handback: "detached",
        status: name === "finished" ? "completed" : "processing",
        ...(name === "finished" ? { response: "the late answer" } : {}),
        createdAt: longAgo,
        updatedAt: longAgo,
        expiresAt: Date.now() + 60_000,
      }),
    );
    const spies = [
      spyOn(asyncAgentResults, "listOwedAsyncAgentResults").mockImplementation(
        async (options: {
          handback?: string;
          status: string;
        }): Promise<{
          page: AsyncAgentResultRecord[];
          cursor: string;
          isDone: boolean;
        }> => ({
          page: rows.filter(
            (row): boolean =>
              row.handback === options.handback &&
              row.status === options.status,
          ),
          cursor: "end",
          isDone: true,
        }),
      ),
      spyOn(handler, "loadReentryTarget").mockResolvedValue({
        agentConfig: {},
        conversationKey: parentKey,
      }),
      spyOn(ingress, "recoverQueuedIngress").mockResolvedValue({
        recovered: [],
        continueAfter: null,
      }),
    ];
    const failed = spyOn(
      asyncAgentResults,
      "recordAsyncAgentResult",
    ).mockResolvedValue();
    const admitted: IngressCandidate[] = [];
    const accept = spyOn(ingress, "acceptIngress").mockImplementation(
      async (candidate: IngressCandidate): Promise<IngressAdmission> => {
        admitted.push(candidate);

        return { outcome: "queued" };
      },
    );
    try {
      startIngressRecovery();
      for (
        let i = 0;
        i < 200 && (admitted.length < 1 || failed.mock.calls.length < 1);
        i += 1
      ) {
        await Bun.sleep(1);
      }

      expect(failed.mock.calls).toEqual([
        [
          rows[1]!.eventId,
          { status: "failed", error: expect.stringContaining("restarted") },
          { onlyWhileProcessing: true },
        ],
      ]);
      expect(admitted).toEqual([
        expect.objectContaining({
          eventId: `${parentEventId}:async-subagent:${subagentTaskNonce(taskIds[0]!)}`,
          conversationKey: parentKey,
          requestedMode: "followup",
          resultEventId: rows[0]!.eventId,
        }),
      ]);
      expect(JSON.stringify(admitted[0]?.events)).toContain("the late answer");
    } finally {
      for (const spy of spies) spy.mockRestore();
      failed.mockRestore();
      accept.mockRestore();
    }
  });
});
