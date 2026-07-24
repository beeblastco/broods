/**
 * Runtime key helper tests.
 */

import { describe, expect, it } from "bun:test";
import {
  assertValidPublicEventId,
  assertValidPublicStatusEventId,
  channelScopeKeyFromConversation,
  createSubagentTaskId,
  parseAccountAgentScopedKey,
  subagentParentEventId,
} from "../src/shared/runtime-keys.ts";

describe("channelScopeKeyFromConversation", () => {
  it("keeps Slack channel isolation at team+channel and conversation isolation at full thread key", () => {
    expect(
      channelScopeKeyFromConversation("slack:T123:C456:1719760000.000000"),
    ).toBe("slack:T123:C456");
    expect(
      channelScopeKeyFromConversation(
        "slack:T123:C456:1719760000.000000",
        "conversation",
      ),
    ).toBe("slack:T123:C456:1719760000.000000");
    expect(
      channelScopeKeyFromConversation(
        "acct:acct_1:agent:agent_1:slack:T123:C456:1719760000.000000",
      ),
    ).toBe("slack:T123:C456");
  });

  it("derives provider channel keys for Pancake and GitHub", () => {
    expect(
      channelScopeKeyFromConversation("pancake:page-1:conversation-1"),
    ).toBe("pancake:page-1");
    expect(channelScopeKeyFromConversation("gh:owner/repo:issue:123")).toBe(
      "gh:owner/repo",
    );
    expect(
      channelScopeKeyFromConversation(
        "acct:acct_1:agent:agent_1:gh:owner/repo:pr:123",
      ),
    ).toBe("gh:owner/repo");
  });

  it("collapses Discord thread conversations to guild+channel for channel isolation", () => {
    expect(
      channelScopeKeyFromConversation("discord:guild-1:channel-1:thread-1"),
    ).toBe("discord:guild-1:channel-1");
    expect(channelScopeKeyFromConversation("discord:guild-1:channel-1")).toBe(
      "discord:guild-1:channel-1",
    );
    expect(
      channelScopeKeyFromConversation(
        "acct:acct_1:agent:agent_1:discord:guild-1:channel-1:thread-1",
      ),
    ).toBe("discord:guild-1:channel-1");
  });

  it("falls back to the whole conversation key for direct/custom conversations", () => {
    expect(channelScopeKeyFromConversation("api:thread-1")).toBe(
      "api:thread-1",
    );
  });
});

describe("subagent task correlation", () => {
  it("round-trips a server-scoped parent event through a server-correlated task id", () => {
    const parentEventId = "acct:acct_1:agent:agent_parent:api:parent-event";
    const taskId = createSubagentTaskId(
      parentEventId,
      "019833ce-7f5d-7000-8000-000000000001",
    );

    expect(taskId.startsWith("subagent~")).toBe(true);
    expect(() => assertValidPublicEventId(taskId)).toThrow(
      "reserved internal prefix",
    );
    expect(assertValidPublicStatusEventId(taskId)).toBe(taskId);
    expect(() =>
      assertValidPublicStatusEventId(
        "subagent~not-a-canonical-task-correlation",
      ),
    ).toThrow("reserved internal prefix");
    expect(subagentParentEventId(taskId)).toBe(parentEventId);
    expect(parseAccountAgentScopedKey(parentEventId)).toEqual({
      accountId: "acct_1",
      agentId: "agent_parent",
      key: "api:parent-event",
    });
  });

  it("supports channel parents and rejects malformed or unscoped correlations", () => {
    expect(subagentParentEventId("subagent_task_1")).toBeNull();
    expect(
      subagentParentEventId(
        "subagent~bm90LXNjb3BlZA~019833ce-7f5d-7000-8000-000000000001",
      ),
    ).toBeNull();
    const channelParent = "acct:acct_1:agent:agent_parent:slack:thread";
    expect(
      subagentParentEventId(
        createSubagentTaskId(
          channelParent,
          "019833ce-7f5d-7000-8000-000000000001",
        ),
      ),
    ).toBe(channelParent);
    expect(() =>
      createSubagentTaskId(
        "unscoped-parent",
        "019833ce-7f5d-7000-8000-000000000001",
      ),
    ).toThrow("account and agent scoped");
  });
});
