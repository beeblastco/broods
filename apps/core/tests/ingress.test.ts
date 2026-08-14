/** Durable ingress admission payload contract tests. */

import { afterEach, describe, expect, it } from "bun:test";
import { runtime } from "../src/shared/convex/runtime.ts";
import {
  acceptIngress,
  prepareSessionMessage,
  type ConversationDispatchTarget,
  type IngressCandidate,
} from "../src/harness/ingress.ts";

const originalMutate = runtime.mutate;
const originalQuery = runtime.query;

afterEach(() => {
  runtime.mutate = originalMutate;
  runtime.query = originalQuery;
});

function candidate(): IngressCandidate {
  return {
    accountId: "acct_1",
    agentId: "agent_1",
    eventId: "event-1",
    conversationKey: "acct:acct_1:agent:agent_1:api:conversation-1",
    events: [{ role: "user", content: "hello" }],
    requestedMode: "followup",
    idempotencyKey: "event-1",
    delivery: {
      kind: "http",
      publicEventId: "event-1",
      publicConversationKey: "conversation-1",
    },
  };
}

describe("ingress admission payloads", () => {
  it(
    "remembers channel delivery as a session target",
    async (): Promise<void> => {
      let call: Record<string, unknown> | undefined;
      runtime.mutate = (async (
        _name: string,
        args: Record<string, unknown>,
      ): Promise<{ outcome: "owner"; ownerGeneration: number }> => {
        call = args;

        return { outcome: "owner", ownerGeneration: 1 };
      }) as never;
      const agentConfig = { channels: { telegram: { botToken: "secret" } } };

      await acceptIngress({
        ...candidate(),
        agentConfig: agentConfig,
        delivery: {
          kind: "channel",
          channel: "telegram",
          source: { chatId: "chat-1" },
        },
      });

      expect(call?.channelTarget).toEqual({
        agentConfig: agentConfig,
        channelName: "telegram",
        source: { chatId: "chat-1" },
      });
    },
  );

  it("persists per-request execution context and covers it in the digest", async () => {
    const calls: Array<Record<string, unknown>> = [];
    runtime.mutate = (async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);

      return { outcome: "queued" };
    }) as never;

    await acceptIngress({
      ...candidate(),
      agentConfig: { model: { temperature: 0.1 } },
      ephemeralSystem: [{ role: "system", content: "one-turn override" }],
    });
    await acceptIngress({
      ...candidate(),
      agentConfig: { model: { temperature: 0.9 } },
    });
    await acceptIngress(candidate());

    const [first, second, third] = calls;
    expect(first!.agentConfig).toEqual({ model: { temperature: 0.1 } });
    expect(first!.ephemeralSystem).toEqual([
      { role: "system", content: "one-turn override" },
    ]);
    // Different model/system overrides must never collapse into the same
    // idempotent payload identity.
    expect(first!.payloadDigest).not.toBe(second!.payloadDigest);
    expect(second!.payloadDigest).not.toBe(third!.payloadDigest);
    // Queue byte accounting includes the persisted execution context.
    expect(first!.sizeBytes as number).toBeGreaterThan(
      third!.sizeBytes as number,
    );
  });

  it("keeps the digest stable when no overrides are supplied", async () => {
    const calls: Array<Record<string, unknown>> = [];
    runtime.mutate = (async (_name: string, args: Record<string, unknown>) => {
      calls.push(args);

      return { outcome: "owner", ownerGeneration: 1 };
    }) as never;

    await acceptIngress(candidate());
    await acceptIngress(candidate());
    expect(calls[0]!.payloadDigest).toBe(calls[1]!.payloadDigest);
  });
});

describe("session messages", (): void => {
  it("builds a follow-up for another channel session", async (): Promise<void> => {
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
    const prepared = await prepareSessionMessage({
      accountId: "acct_test",
      agentId: "agent_test",
      sourceConversationKey:
        "acct:acct_test:agent:agent_test:tg:source-chat",
      input: {
        conversationKey: "tg:target-chat",
        message: "Please follow up",
      },
    });

    expect(queryArgs).toEqual({
      accountId: "acct_test",
      agentId: "agent_test",
      conversationKey: "acct:acct_test:agent:agent_test:tg:target-chat",
    });
    expect(prepared.candidate).toMatchObject({
      agentConfig: target.agentConfig,
      conversationKey: "acct:acct_test:agent:agent_test:tg:target-chat",
      delivery: {
        kind: "channel",
        channel: "telegram",
        source: { chatId: "target-chat" },
      },
      requestedMode: "followup",
      events: [
        {
          role: "user",
          content:
            "[Inter-session message from tg:source-chat]\nPlease follow up",
        },
      ],
    });
    expect(prepared.publicConversationKey).toBe("tg:target-chat");
  });

  it(
    "rejects the current conversation and another agent's conversation",
    async (): Promise<void> => {
      const options = {
        accountId: "acct_test",
        agentId: "agent_test",
        sourceConversationKey:
          "acct:acct_test:agent:agent_test:tg:source-chat",
      };

      await expect(
        prepareSessionMessage({
          ...options,
          input: { conversationKey: "tg:source-chat", message: "loop" },
        }),
      ).rejects.toThrow("cannot target the current conversation");
      await expect(
        prepareSessionMessage({
          ...options,
          input: {
            conversationKey:
              "acct:acct_test:agent:agent_other:tg:another-conversation",
            message: "cross-agent",
          },
        }),
      ).rejects.toThrow("must belong to the current agent");
    },
  );
});
