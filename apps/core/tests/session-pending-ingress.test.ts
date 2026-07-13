/** Session conversation persistence wrappers over paged Convex operations. */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { UserModelMessage } from "ai";
import { runtimePersistence } from "../src/shared/storage/convex/runtime.ts";
import { Session } from "../src/harness/session.ts";

const originalMutation = runtimePersistence.mutation;
const originalQuery = runtimePersistence.query;
const mutationMock = mock(async (name: string, _args: Record<string, unknown>) =>
  name === "takeIngress" ? [] : null);
const queryMock = mock(
  async (_name: string, _args: Record<string, unknown>): Promise<{
    page: Array<{ cursor: string; event: unknown }>;
    isDone: boolean;
    continueCursor: string | null;
  }> => ({
    page: [],
    isDone: true,
    continueCursor: null,
  }),
);
const newSession = () => new Session("acct:acct:event-1", "acct:acct:agent:agent:tg:123", "acct", "agent");

beforeEach(() => {
  runtimePersistence.mutation = mutationMock as never;
  runtimePersistence.query = queryMock as never;
});
afterEach(() => {
  runtimePersistence.mutation = originalMutation;
  runtimePersistence.query = originalQuery;
  mutationMock.mockClear();
  queryMock.mockClear();
});

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

  it("loads every conversation page including later compaction summaries", async () => {
    queryMock
      .mockResolvedValueOnce({
        page: [{
          cursor: "001",
          event: {
            version: 1,
            sourceEventId: "event-1",
            message: { role: "user", content: "first" },
          },
        }],
        isDone: false,
        continueCursor: "001",
      })
      .mockResolvedValueOnce({
        page: [{
          cursor: "002",
          event: {
            version: 1,
            sourceEventId: "event-2",
            message: { role: "system", content: "later compaction summary" },
          },
        }],
        isDone: true,
        continueCursor: null,
      });
    const session = newSession() as unknown as {
      loadConversationEntries(): Promise<Array<{
        createdAt: string;
        event: { message: { role: string; content: string } };
      }>>;
    };

    await expect(session.loadConversationEntries()).resolves.toEqual([
      expect.objectContaining({ createdAt: "001" }),
      expect.objectContaining({
        createdAt: "002",
        event: expect.objectContaining({
          message: { role: "system", content: "later compaction summary" },
        }),
      }),
    ]);
    expect(queryMock.mock.calls).toEqual([
      ["listConversationEvents", {
        conversationKey: "acct:acct:agent:agent:tg:123",
        afterCursor: undefined,
      }],
      ["listConversationEvents", {
        conversationKey: "acct:acct:agent:agent:tg:123",
        afterCursor: "001",
      }],
    ]);
  });
});
