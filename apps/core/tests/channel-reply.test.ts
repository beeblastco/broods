/**
 * Channel push-back tests.
 * Cover sendChannelReply rebuilding a channel sender from agent config + the
 * stored routing source, so a background job's result reaches the originating
 * chat outside the inbound webhook.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sendChannelReply } from "../functions/harness-processing/integrations.ts";
import type { AgentConfig } from "../functions/_shared/storage/index.ts";

type FetchInput = string | URL | Request;

interface FetchCall {
  input: FetchInput;
  init?: RequestInit;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("sendChannelReply", () => {
  it("rebuilds the telegram sender from config + source and posts to the chat", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(new Response(JSON.stringify({ ok: true, result: { message_id: 101, chat: { id: 555 } } }), { status: 200 }));

    const config: AgentConfig = {
      channels: {
        telegram: {
          botToken: "bot-xyz",
          webhookSecret: "secret",
          allowedChatIds: [555],
        },
      },
    };

    await sendChannelReply({
      config,
      accountId: "acct-1",
      agentId: "agent-1",
      channelName: "telegram",
      source: { chatId: 555, messageId: "555:100", threadId: "telegram:555" },
      text: "background job done",
    });

    expect(fetchMock.calls).toHaveLength(1);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://api.telegram.org/botbot-xyz/sendRichMessage",
    );
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toMatchObject({
      chat_id: "555",
      rich_message: { markdown: "background job done" },
    });
  });

  it("throws when the channel is not configured for the agent", async () => {
    installFetchMock();
    await expect(
      sendChannelReply({
        config: {},
        accountId: "acct-1",
        agentId: "agent-1",
        channelName: "telegram",
        source: { chatId: 555, messageId: "555:100", threadId: "telegram:555" },
        text: "hello",
      }),
    ).rejects.toThrow("Channel telegram is not configured");
  });
});

function installFetchMock() {
  const calls: FetchCall[] = [];
  const responses: Response[] = [];

  globalThis.fetch = (async (input: FetchInput, init?: RequestInit) => {
    calls.push({ input, init });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${toUrl(input)}`);
    }
    return response;
  }) as unknown as typeof fetch;

  return { calls, responses };
}

function toUrl(input: FetchInput): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}
