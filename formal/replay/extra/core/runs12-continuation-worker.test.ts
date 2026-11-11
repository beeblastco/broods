import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as ingress from "../../../../apps/core/src/harness/ingress.ts";
import type { IngressCandidate } from "../../../../apps/core/src/harness/ingress.ts";
import * as workerQueue from "../../../../apps/core/src/harness/worker-queue.ts";
import type { AsyncToolDelivery } from "../../../../apps/core/src/harness/async-tool-result.ts";
import type { ReentryTarget } from "../../../../apps/core/src/harness/integrations.ts";
import { runtime } from "../../../../apps/core/src/shared/convex/runtime.ts";
import {
  createSubagentTaskId,
  scopedDirectConversationKey,
  scopedDirectEventId,
} from "../../../../apps/core/src/shared/runtime-keys.ts";

const { resumeAfterSubagentResult } =
  await import("../../../../apps/core/src/harness/handler.ts");

const PARENT_EVENT = scopedDirectEventId("acct_1", "agent_1", "event_1");
const PARENT_KEY = scopedDirectConversationKey("acct_1", "agent_1", "chat");
const TARGET: ReentryTarget = { agentConfig: {}, conversationKey: PARENT_KEY };

const admitted: IngressCandidate[] = [];
const dispatched: { kind: string; lease: unknown }[] = [];
let outcome: Awaited<ReturnType<typeof ingress.acceptIngress>> = {
  outcome: "owner",
  ownerGeneration: 4,
};

function resume(
  delivery: AsyncToolDelivery | undefined,
): ReturnType<typeof resumeAfterSubagentResult> {
  return resumeAfterSubagentResult(
    {
      accountId: "acct_1",
      agentId: "agent_1",
      eventId: PARENT_EVENT,
      conversationKey: PARENT_KEY,
      delivery: delivery,
    },
    createSubagentTaskId(PARENT_EVENT),
    { role: "user", content: "late result" },
    undefined,
    TARGET,
  );
}

beforeEach((): void => {
  outcome = { outcome: "owner", ownerGeneration: 4 };
  spyOn(ingress, "acceptIngress").mockImplementation(
    async (candidate): Promise<typeof outcome> => {
      admitted.push(candidate);

      return outcome;
    },
  );
  spyOn(runtime, "mutate").mockResolvedValue(true);
  spyOn(workerQueue, "dispatchInProcessWorker").mockImplementation(
    (kind, _run, lease): void => {
      dispatched.push({ kind: kind, lease: lease });
    },
  );
});

afterEach((): void => {
  admitted.length = 0;
  dispatched.length = 0;
  spyOn(ingress, "acceptIngress").mockRestore();
  spyOn(runtime, "mutate").mockRestore();
  spyOn(workerQueue, "dispatchInProcessWorker").mockRestore();
});

describe("a continuation the admission made owner", (): void => {
  test("a websocket parent is resumed by the nats worker on its own socket", async (): Promise<void> => {
    expect(
      await resume({
        kind: "nats",
        connectionId: "conn_1",
        publicEventId: "socket-event",
        publicConversationKey: "socket-chat",
      }),
    ).toBe("owner");

    expect(dispatched).toEqual([
      {
        kind: "nats-worker",
        lease: {
          conversationKey: PARENT_KEY,
          ownerEventId: expect.stringContaining(":async-subagent:"),
          ownerGeneration: 4,
        },
      },
    ]);
    expect(admitted[0]?.delivery).toMatchObject({
      kind: "websocket",
      connectionId: "conn_1",
      publicEventId: "socket-event",
      publicConversationKey: "socket-chat",
    });
  });

  test("any other parent is resumed by the async worker", async (): Promise<void> => {
    expect(await resume({ kind: "async" })).toBe("owner");
    expect(await resume(undefined)).toBe("owner");

    expect(dispatched.map((entry): string => entry.kind)).toEqual([
      "direct-api-async-worker",
      "direct-api-async-worker",
    ]);
    expect(admitted[0]?.delivery).toMatchObject({ kind: "async" });
  });

  test("a continuation someone else owns starts no worker", async (): Promise<void> => {
    outcome = { outcome: "queued" };

    expect(await resume({ kind: "async" })).toBe("queued");
    expect(dispatched).toEqual([]);
  });
});
