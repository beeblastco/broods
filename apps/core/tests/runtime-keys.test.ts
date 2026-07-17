/**
 * Runtime key helper tests.
 */

import { describe, expect, it } from "bun:test";
import { channelScopeKeyFromConversation } from "../src/shared/runtime-keys.ts";

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
