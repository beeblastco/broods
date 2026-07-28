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
    expect(() =>
      createSubagentTaskId("acct:acct_1:agent:agent_parent:api:event_1", "nope"),
    ).toThrow("must be a UUID");
  });

  it("rejects a task id whose parent segment is not canonical base64url", () => {
    // Length deliberately not a multiple of 3, so the encoding's final character
    // carries slack bits and alias spellings exist at all.
    const parent = "acct:acct_1:agent:agent_parent:api:event_10";
    const canonical = Buffer.from(parent, "utf8").toString("base64url");
    const nonce = "019833ce-7f5d-7000-8000-000000000001";
    // An alias spelling: still [A-Za-z0-9_-], still decodes to the same parent,
    // but re-encodes differently because its final character carries slack bits.
    const alias = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
      .split("")
      .map((character) => canonical.slice(0, -1) + character)
      .find(
        (candidate) =>
          candidate !== canonical &&
          Buffer.from(candidate, "base64url").toString("utf8") === parent,
      );

    expect(subagentParentEventId(`subagent~${canonical}~${nonce}`)).toBe(parent);
    expect(alias).toBeDefined();
    // Without the round-trip guard one parent would have several task-id spellings.
    expect(subagentParentEventId(`subagent~${alias}~${nonce}`)).toBeNull();
  });
});
