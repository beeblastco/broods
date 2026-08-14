/**
 * Inter-session message targeting tests.
 * Cover scope checks and target-session ingress construction.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { ConversationDispatchTarget } from "../src/harness/ingress.ts";
import { prepareSessionMessage } from "../src/harness/session-messages.ts";
import { Session } from "../src/harness/session.ts";
import { runtime } from "../src/shared/convex/runtime.ts";

const originalQuery = runtime.query;

afterEach(() => {
  runtime.query = originalQuery;
});

describe("prepareSessionMessage", () => {
  it("builds a follow-up for another channel session", async () => {
    const target: ConversationDispatchTarget = {
      agentConfig: { channels: { telegram: { botToken: "secret" } } },
      channelName: "telegram",
      source: { chatId: "target-chat" },
    };
    let queryArgs: Record<string, unknown> | undefined;
    runtime.query = async function <T>(
      name: Parameters<typeof runtime.query>[0],
      args: Record<string, unknown>,
    ): Promise<T> {
      expect(name).toBe("getConversationTarget");
      queryArgs = args;

      return target as T;
    };
    const prepared = await prepareSessionMessage(currentSession(), {
      conversationKey: "tg:target-chat",
      message: "Please follow up",
    });

    expect(queryArgs).toEqual({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "acct:acct_test:agent:agent_test:tg:target-chat",
    });
    expect(prepared.delivery).toEqual({
      kind: "channel",
      channel: "telegram",
      source: { chatId: "target-chat" },
    });
    expect(prepared.event).toMatchObject({
      agentConfig: target.agentConfig,
      conversationKey: "acct:acct_test:agent:agent_test:tg:target-chat",
      publicConversationKey: "tg:target-chat",
      requestedMode: "followup",
      replyTarget: {
        channelName: "telegram",
        source: { chatId: "target-chat" },
      },
      events: [
        {
          role: "user",
          content:
            "[Inter-session message from tg:source-chat]\nPlease follow up",
        },
      ],
    });
  });

  it("rejects the current conversation and another agent's conversation", async () => {
    await expect(
      prepareSessionMessage(currentSession(), {
        conversationKey: "tg:source-chat",
        message: "loop",
      }),
    ).rejects.toThrow("cannot target the current conversation");
    await expect(
      prepareSessionMessage(currentSession(), {
        conversationKey:
          "acct:acct_test:agent:agent_other:tg:another-conversation",
        message: "cross-agent",
      }),
    ).rejects.toThrow("must belong to the current agent");
  });
});

function currentSession(): Session {
  return new Session(
    "acct:acct_test:agent:agent_test:event-1",
    "acct:acct_test:agent:agent_test:tg:source-chat",
    "acct_test",
    "agent_test",
  );
}
