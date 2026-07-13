/** Session pending-ingress queue wrappers over atomic Convex mutations. */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { UserModelMessage } from "ai";
import { runtimePersistence } from "../src/shared/storage/convex/runtime.ts";
import { Session } from "../src/harness/session.ts";

const originalMutation = runtimePersistence.mutation;
const mutationMock = mock(async (name: string, _args: Record<string, unknown>) =>
  name === "takeIngress" ? [] : null);
const newSession = () => new Session("acct:acct:event-1", "acct:acct:agent:agent:tg:123", "acct", "agent");

beforeEach(() => { runtimePersistence.mutation = mutationMock as never; });
afterEach(() => { runtimePersistence.mutation = originalMutation; mutationMock.mockClear(); });

describe("Session pending ingress queue", () => {
  it("enqueues structured events under the per-conversation pending key", async () => {
    const message: UserModelMessage = { role: "user", content: "second message" };
    await newSession().enqueuePendingIngress([message]);
    expect(mutationMock).toHaveBeenCalledWith("enqueueIngress", expect.objectContaining({
      key: expect.stringContaining("pending:conversation-lease:"),
      conversationKey: "acct:acct:agent:agent:tg:123",
      events: [message],
    }));
  });

  it("does not write when there is nothing to enqueue", async () => {
    await newSession().enqueuePendingIngress([]);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("returns the transactionally drained event list", async () => {
    const events: UserModelMessage[] = [{ role: "user", content: "first" }, { role: "user", content: "second" }];
    mutationMock.mockResolvedValueOnce(events as never);
    await expect(newSession().takePendingIngress()).resolves.toEqual(events);
    expect(mutationMock).toHaveBeenCalledWith("takeIngress", {
      key: expect.stringContaining("pending:conversation-lease:"),
    });
  });
});
