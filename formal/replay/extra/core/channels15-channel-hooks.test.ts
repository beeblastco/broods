import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as hookDispatcher from "../../../../apps/core/src/harness/hook-dispatcher.ts";
import {
  createIncomingEventRouter,
  sendChannelReply,
  type ChannelInboundEvent,
} from "../../../../apps/core/src/harness/integrations.ts";
import type { AgentConfig } from "../../../../apps/core/src/shared/domain/agent-config.ts";
import type { AgentRecord } from "../../../../apps/core/src/shared/domain/agents.ts";
import { coreRequest } from "../../../../apps/core/tests/helpers/http.ts";

type Mutation = Record<string, unknown> | undefined;

const STAMP = "2026-07-20T00:00:00.000Z";
const TELEGRAM_SECRET = "telegram-secret-value";
const ORIGINAL_FETCH = globalThis.fetch;

const TELEGRAM_CONFIG: AgentConfig = {
  channels: {
    telegram: {
      botToken: "telegram-token",
      webhookSecret: TELEGRAM_SECRET,
      allowedChannelIds: ["123"],
    },
  },
};

const SLACK_CONFIG: AgentConfig = {
  channels: {
    slack: { botToken: "slack-bot-token", signingSecret: "slack-secret" },
  },
};

const ACCOUNT = {
  accountId: "acct_test",
  username: "test-account",
  description: "Test account",
  secretHash: "hash",
  status: "active" as const,
  config: {},
  createdAt: STAMP,
  updatedAt: STAMP,
};

let mutation: Mutation;
const asked: string[] = [];
const fetched: string[] = [];

beforeEach((): void => {
  mutation = undefined;
  asked.length = 0;
  fetched.length = 0;
  spyOn(hookDispatcher, "createAgentHookDispatcher").mockResolvedValue({
    hasHooksFor: (): boolean => true,
    runMutation: async (event: string): Promise<Mutation> => {
      asked.push(event);

      return mutation;
    },
  });
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request): Promise<Response> => {
      fetched.push(String(input instanceof Request ? input.url : input));

      return Response.json({
        ok: true,
        result: {
          message_id: 1,
          date: 1713916800,
          chat: { id: 123, type: "private" },
          text: "sent",
        },
      });
    },
    { preconnect: ORIGINAL_FETCH.preconnect },
  );
});

afterEach((): void => {
  spyOn(hookDispatcher, "createAgentHookDispatcher").mockRestore();
  globalThis.fetch = ORIGINAL_FETCH;
});

function agent(agentId: string, config: AgentConfig): AgentRecord {
  return {
    accountId: "acct_test",
    agentId: agentId,
    name: agentId,
    config: config,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

function telegramRequest(text: string): ReturnType<typeof coreRequest> {
  return coreRequest(
    "POST",
    "/v1/webhooks/acct_test/telegram",
    { "x-telegram-bot-api-secret-token": TELEGRAM_SECRET },
    {
      update_id: 7,
      message: {
        message_id: 9,
        date: 1713916800,
        text: text,
        chat: { id: 123, type: "private" },
        from: { id: 456, is_bot: false, username: "alice" },
      },
    },
  );
}

function slackCommandRequest(): ReturnType<typeof coreRequest> {
  const body =
    "team_id=T1&channel_id=C1&command=%2Fnew&text=&user_id=U1&trigger_id=trig-1";
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", "slack-secret")
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");

  return coreRequest(
    "POST",
    "/v1/webhooks/acct_test/slack",
    {
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  );
}

async function turns(
  request: ReturnType<typeof coreRequest>,
  config: AgentConfig,
): Promise<ChannelInboundEvent[]> {
  const handled: ChannelInboundEvent[] = [];
  const waited: Promise<unknown>[] = [];
  const record = agent("agent_test", config);
  const router = createIncomingEventRouter({
    accountLoader: async (): Promise<typeof ACCOUNT> => ACCOUNT,
    agentLoader: async (): Promise<AgentRecord> => record,
    agentLister: async (): Promise<AgentRecord[]> => [record],
    channelRecordLoader: async (): Promise<null> => null,
    deploymentLoader: async (): Promise<null> => null,
    waitUntil: (promise: Promise<unknown>): void => {
      waited.push(Promise.resolve(promise).catch((): void => {}));
    },
  });
  await router(request, {
    handleDirectRequest: async (): Promise<Response> => new Response("ok"),
    handleChannelRequest: async (event): Promise<void> => {
      handled.push(event);
    },
  });
  await Promise.all(waited);

  return handled;
}

describe("processChannelMessage hooks", (): void => {
  test("drops a message the receive hook drops", async (): Promise<void> => {
    mutation = { drop: true };

    const handled = await turns(telegramRequest("spam"), TELEGRAM_CONFIG);

    expect(handled).toHaveLength(0);
    expect(asked).toEqual(["channel.message.received"]);
  });

  test("rewrites the text and attaches metadata from the receive hook", async (): Promise<void> => {
    mutation = { text: "SHOUTED", metadata: { source: "hook" } };

    const [event] = await turns(telegramRequest("hello"), TELEGRAM_CONFIG);

    expect(event?.content).toBe("SHOUTED");
    expect(event?.events).toEqual([
      { role: "user", content: "SHOUTED", metadata: { source: "hook" } },
    ]);
  });
});

describe("resolveCommandToken", (): void => {
  test("reads an inline command from the message text", async (): Promise<void> => {
    const [event] = await turns(telegramRequest("/new"), TELEGRAM_CONFIG);

    expect(event?.commandToken).toBe("/new");
  });

  test("takes the token a slash command carries in its source", async (): Promise<void> => {
    const [event] = await turns(slackCommandRequest(), SLACK_CONFIG);

    expect(event?.commandToken).toBe("/new");
  });
});

describe("sendChannelReply", (): void => {
  test("drops a reply the sending hook drops", async (): Promise<void> => {
    mutation = { drop: true };

    await sendChannelReply({
      config: TELEGRAM_CONFIG,
      accountId: "acct_test",
      channelName: "telegram",
      source: { chatId: 123, messageId: "123:9", threadId: "telegram:123" },
      text: "done",
    });

    expect(asked).toEqual(["channel.message.sending"]);
    expect(fetched).toHaveLength(0);
  });

  test("sends the text the sending hook rewrites", async (): Promise<void> => {
    mutation = { text: "rewritten" };

    await sendChannelReply({
      config: TELEGRAM_CONFIG,
      accountId: "acct_test",
      channelName: "telegram",
      source: { chatId: 123, messageId: "123:9", threadId: "telegram:123" },
      text: "done",
    });

    expect(fetched).toHaveLength(1);
  });
});
