import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentRecord } from "../../../../apps/core/src/shared/domain/agents.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import { Session } from "../../../../apps/core/src/harness/session.ts";
import { SubagentCoordinator } from "../../../../apps/core/src/harness/subagents.ts";
import {
  getStorage,
  resetStorageForTests,
} from "../../../../apps/core/src/shared/storage.ts";

type Resolve = (accountId: string, agentId: string) => Promise<AgentRecord>;

const CHILD: AgentRecord = {
  accountId: "acct_1",
  agentId: "agent_2",
  name: "researcher",
  config: {},
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

// `resolveAllowedAgent` is private and only the dispatch path calls it, so the test calls it
// directly.
function resolver(config: AgentConfig): Resolve {
  const coordinator = new SubagentCoordinator(
    new Session({
      eventId: "event_1",
      conversationKey: "acct:acct_1:agent:agent_1:api:chat",
      accountId: "acct_1",
      agentId: "agent_1",
    }),
    config,
  );
  const reach = coordinator as unknown as { resolveAllowedAgent: Resolve };

  return (accountId, agentId): Promise<AgentRecord> =>
    reach.resolveAllowedAgent(accountId, agentId);
}

afterEach((): void => {
  mock.restore();
  resetStorageForTests();
});

describe("resolveAllowedAgent", (): void => {
  test("an allowed agent is read from storage for the parent's account", async (): Promise<void> => {
    const read = spyOn(getStorage().agents, "getById").mockResolvedValue(CHILD);

    const agent = await resolver({
      subagent: { allowed: ["agent_2", "agent_3"] },
    })("acct_1", "agent_2");

    expect(agent).toBe(CHILD);
    expect(read).toHaveBeenCalledWith("acct_1", "agent_2");
  });

  test("an agent outside the allow list is refused without a storage read", async (): Promise<void> => {
    const read = spyOn(getStorage().agents, "getById").mockResolvedValue(CHILD);

    await expect(
      resolver({ subagent: { allowed: ["agent_2"] } })("acct_1", "agent_3"),
    ).rejects.toThrow("Subagent is not allowed: agent_3");
    await expect(resolver({})("acct_1", "agent_2")).rejects.toThrow(
      "Subagent is not allowed: agent_2",
    );
    expect(read).not.toHaveBeenCalled();
  });

  test("an allowed agent that no longer exists is a not-found error", async (): Promise<void> => {
    spyOn(getStorage().agents, "getById").mockResolvedValue(null);

    await expect(
      resolver({ subagent: { allowed: ["agent_2"] } })("acct_1", "agent_2"),
    ).rejects.toThrow("Subagent not found: agent_2");
  });
});
