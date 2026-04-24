/**
 * Channel action tests.
 * Cover outbound Discord and Slack reply branches here with mocked fetch calls.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createDiscordChannel } from "../functions/_shared/discord-channel.ts";
import { createSlackChannel } from "../functions/_shared/slack-channel.ts";

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

describe("discord channel actions", () => {
  it("splits long replies, sends typing, and ignores reactions", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      new Response("", { status: 200 }),
      new Response("", { status: 200 }),
      new Response("", { status: 204 }),
    );

    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    await actions.sendText(`${"hello ".repeat(450)}tail`);
    await actions.sendTyping();
    await actions.reactToMessage();

    expect(fetchMock.calls).toHaveLength(3);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe(
      "https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original",
    );
    expect(fetchMock.calls[0]!.init?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toMatchObject({
      allowed_mentions: { parse: [] },
    });

    expect(toUrl(fetchMock.calls[1]!.input)).toBe(
      "https://discord.com/api/v10/webhooks/app-1/interaction-token",
    );
    expect(fetchMock.calls[1]!.init?.method).toBe("POST");

    expect(toUrl(fetchMock.calls[2]!.input)).toBe(
      "https://discord.com/api/v10/channels/channel-1/typing",
    );
    expect(fetchMock.calls[2]!.init?.headers).toEqual({
      Authorization: "Bot bot-token",
    });
  });

  it("throws when a Discord reply or typing request fails", async () => {
    const fetchMock = installFetchMock();
    const actions = createDiscordChannel("bot-token", "public-key", null).actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
        channelId: "channel-1",
      }),
    );

    fetchMock.responses.push(new Response("boom", { status: 500 }));
    await expect(actions.sendText("hello")).rejects.toThrow(
      "Discord reply failed (500): boom",
    );

    fetchMock.responses.push(new Response("nope", { status: 403 }));
    await expect(actions.sendTyping()).rejects.toThrow(
      "Discord typing indicator failed (403): nope",
    );
  });

  it("skips typing without a channel id and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createDiscordChannel("bot-token", "public-key", null);
    const actions = adapter.actions(
      createMessage({
        applicationId: "app-1",
        interactionToken: "interaction-token",
        interactionId: "interaction-1",
      }),
    );

    await actions.sendTyping();
    expect(fetchMock.calls).toHaveLength(0);

    expect(() =>
      adapter.actions(createMessage({
        applicationId: "app-1",
      })),
    ).toThrow("Invalid Discord source payload");
  });
});

describe("slack channel actions", () => {
  it("posts to response_url payloads with formatted table attachments", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(new Response("", { status: 200 }));

    const actions = createSlackChannel("bot-token", "signing-secret", null).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        responseUrl: "https://hooks.slack.test/response",
      }),
    );

    await actions.sendText("| Name | Value |\n| --- | --- |\n| Alpha | Beta |");

    expect(fetchMock.calls).toHaveLength(1);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe("https://hooks.slack.test/response");
    expect(fetchMock.calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      text: " ",
      response_type: "in_channel",
      attachments: [{
        blocks: [{
          type: "table",
          column_settings: [{ is_wrapped: true }, null],
          rows: [
            [
              { type: "raw_text", text: "Name" },
              { type: "raw_text", text: "Value" },
            ],
            [
              { type: "raw_text", text: "Alpha" },
              { type: "raw_text", text: "Beta" },
            ],
          ],
        }],
      }],
    });
  });

  it("posts threaded Slack messages and reactions through the Web API", async () => {
    const fetchMock = installFetchMock();
    fetchMock.responses.push(
      jsonResponse({ ok: true }),
      jsonResponse({ ok: true }),
    );

    const actions = createSlackChannel("bot-token", "signing-secret", null).actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        threadTs: "1713916800.000001",
        messageTs: "1713916800.000002",
      }),
    );

    await actions.sendText("hello slack");
    await actions.reactToMessage();
    await actions.sendTyping();

    expect(fetchMock.calls).toHaveLength(2);
    expect(toUrl(fetchMock.calls[0]!.input)).toBe("https://slack.com/api/chat.postMessage");
    expect(fetchMock.calls[0]!.init?.headers).toEqual({
      Authorization: "Bearer bot-token",
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(JSON.parse(String(fetchMock.calls[0]!.init?.body))).toEqual({
      channel: "C1",
      text: "hello slack",
      thread_ts: "1713916800.000001",
    });

    expect(toUrl(fetchMock.calls[1]!.input)).toBe("https://slack.com/api/reactions.add");
    expect(JSON.parse(String(fetchMock.calls[1]!.init?.body))).toEqual({
      channel: "C1",
      timestamp: "1713916800.000002",
      name: "eyes",
    });
  });

  it("skips Slack reactions without a message timestamp and rejects invalid source payloads", async () => {
    const fetchMock = installFetchMock();
    const adapter = createSlackChannel("bot-token", "signing-secret", null);
    const actions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
      }),
    );

    await actions.reactToMessage();
    await actions.sendTyping();
    expect(fetchMock.calls).toHaveLength(0);

    expect(() =>
      adapter.actions(createMessage({
        channelId: "C1",
      })),
    ).toThrow("Invalid Slack source payload");
  });

  it("throws on Slack response_url and Web API failures", async () => {
    const fetchMock = installFetchMock();
    const adapter = createSlackChannel("bot-token", "signing-secret", null);

    const responseUrlActions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        responseUrl: "https://hooks.slack.test/response",
      }),
    );
    fetchMock.responses.push(new Response("", { status: 500 }));
    await expect(responseUrlActions.sendText("hello")).rejects.toThrow(
      "Slack response_url failed (500)",
    );

    const apiActions = adapter.actions(
      createMessage({
        teamId: "T1",
        channelId: "C1",
        messageTs: "1713916800.000002",
      }),
    );
    fetchMock.responses.push(jsonResponse({ ok: false, error: "channel_not_found" }, 200));
    await expect(apiActions.sendText("hello")).rejects.toThrow(
      "Slack chat.postMessage failed (200): channel_not_found",
    );

    fetchMock.responses.push(jsonResponse({ ok: false, error: "missing_scope" }, 403));
    await expect(apiActions.reactToMessage()).rejects.toThrow(
      "Slack reactions.add failed (403): missing_scope",
    );
  });
});

function createMessage(source: Record<string, unknown>) {
  return {
    eventId: "event-1",
    conversationKey: "conversation-1",
    channelName: "test",
    content: [],
    source,
  };
}

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

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
