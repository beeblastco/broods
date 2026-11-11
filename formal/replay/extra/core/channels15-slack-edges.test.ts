import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type {
  ChannelAdapter,
  ChannelParseResult,
} from "../../../../apps/core/src/shared/channels.ts";
import {
  createSlackChannel,
  toSlackStream,
} from "../../../../apps/core/src/shared/slack-channel.ts";

interface SlackRequest {
  method: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  body: string;
}

const TIMESTAMP = "1776988800";
const ORIGINAL_FETCH = globalThis.fetch;

function adapter(
  channels: Set<string> | null,
  users: Set<string> | null,
): ChannelAdapter {
  return createSlackChannel(
    "bot-token",
    "signing-secret",
    channels,
    users,
    "eyes",
    undefined,
    async (userId: string): Promise<string | null> => userId,
  );
}

function request(body: string, contentType: string): SlackRequest {
  const signature = `v0=${createHmac("sha256", "signing-secret")
    .update(`v0:${TIMESTAMP}:${body}`)
    .digest("hex")}`;

  return {
    method: "POST",
    rawPath: "/v1/runs",
    rawQueryString: "",
    headers: {
      "x-slack-request-timestamp": TIMESTAMP,
      "x-slack-signature": signature,
      "content-type": contentType,
    },
    body: body,
  };
}

async function parseEvent(
  event: Record<string, unknown>,
  envelope: Record<string, unknown> = {},
  channels: Set<string> | null = null,
  users: Set<string> | null = null,
): Promise<ChannelParseResult> {
  return await adapter(channels, users).parse(
    request(
      JSON.stringify({
        type: "event_callback",
        event_id: "evt-1",
        team_id: "T1",
        event: event,
        ...envelope,
      }),
      "application/json",
    ),
  );
}

async function parseSlash(
  form: string,
  channels: Set<string> | null = null,
  users: Set<string> | null = null,
): Promise<ChannelParseResult> {
  return await adapter(channels, users).parse(
    request(form, "application/x-www-form-urlencoded"),
  );
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

async function fileFetcher(
  url: string,
  mimetype: string,
): Promise<() => Promise<Buffer>> {
  const parsed = await parseEvent({
    type: "message",
    subtype: "file_share",
    text: "file",
    channel: "D1",
    channel_type: "im",
    user: "U1",
    ts: "1713916800.000050",
    files: [{ id: "F1", name: "f", mimetype: mimetype, url_private: url }],
  });
  if (parsed.kind !== "message") throw new Error(`got ${parsed.kind}`);
  const attachment = parsed.message.attachments?.[0];
  if (!attachment?.fetchData) throw new Error("no fetchData");

  return attachment.fetchData;
}

beforeEach((): void => {
  Object.defineProperty(globalThis, "fetch", {
    value: ORIGINAL_FETCH,
    configurable: true,
    writable: true,
  });
});

afterEach((): void => {
  Object.defineProperty(globalThis, "fetch", {
    value: ORIGINAL_FETCH,
    configurable: true,
    writable: true,
  });
});

function stubFetch(responder: (url: string) => Response): { urls: string[] } {
  const seen: string[] = [];
  Object.defineProperty(globalThis, "fetch", {
    value: async (input: string | URL | Request): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      seen.push(url);

      return responder(url);
    },
    configurable: true,
    writable: true,
  });

  return { urls: seen };
}

describe("fetchSlackFile", (): void => {
  test("follows a redirect and returns the bytes", async (): Promise<void> => {
    const stub = stubFetch((url: string): Response =>
      url.endsWith("/start")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://files.slack-edge.com/real" },
          })
        : new Response("payload", {
            headers: { "content-type": "image/png" },
          }),
    );
    const fetchData = await fileFetcher(
      "https://files.slack.com/start",
      "image/png",
    );

    expect((await fetchData()).toString()).toBe("payload");
    expect(stub.urls).toEqual([
      "https://files.slack.com/start",
      "https://files.slack-edge.com/real",
    ]);
  });

  test("throws on a non-ok status", async (): Promise<void> => {
    stubFetch((): Response => new Response("no", { status: 403 }));
    const fetchData = await fileFetcher(
      "https://files.slack.com/a",
      "image/png",
    );

    await expect(fetchData()).rejects.toThrow("Slack answered 403");
  });

  test("throws on the HTML login page", async (): Promise<void> => {
    stubFetch(
      (): Response =>
        new Response("<html>", { headers: { "content-type": "text/html" } }),
    );
    const fetchData = await fileFetcher(
      "https://files.slack.com/a",
      "image/png",
    );

    await expect(fetchData()).rejects.toThrow(/files:read scope/);
  });

  test("gives up after too many redirects", async (): Promise<void> => {
    const stub = stubFetch(
      (): Response =>
        new Response(null, {
          status: 301,
          headers: { location: "https://files.slack.com/loop" },
        }),
    );
    const fetchData = await fileFetcher(
      "https://files.slack.com/a",
      "image/png",
    );

    await expect(fetchData()).rejects.toThrow("redirected too many times");
    expect(stub.urls.length).toBe(5);
  });

  test("refuses a redirect off Slack", async (): Promise<void> => {
    stubFetch(
      (): Response =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/x" },
        }),
    );
    const fetchData = await fileFetcher(
      "https://files.slack.com/a",
      "image/png",
    );

    await expect(fetchData()).rejects.toThrow("evil.example");
  });
});

describe("assertSlackFileUrl", (): void => {
  test("refuses plain http", async (): Promise<void> => {
    const fetchData = await fileFetcher(
      "http://files.slack.com/a",
      "image/png",
    );

    await expect(fetchData()).rejects.toThrow("over http:");
  });
});

describe("slackAttachmentType", (): void => {
  test("maps video and other mime types", async (): Promise<void> => {
    stubFetch((): Response => new Response("x"));
    const parsed = await parseEvent({
      type: "message",
      subtype: "file_share",
      text: "files",
      channel: "D1",
      channel_type: "im",
      user: "U1",
      ts: "1713916800.000051",
      files: [
        {
          id: "F1",
          mimetype: "video/mp4",
          url_private: "https://files.slack.com/v",
        },
        {
          id: "F2",
          mimetype: "application/pdf",
          url_private: "https://files.slack.com/p",
        },
        { id: "F3", url_private: "https://files.slack.com/n" },
      ],
    });
    if (parsed.kind !== "message") throw new Error(`got ${parsed.kind}`);

    expect(parsed.message.attachments?.map((a): string => a.type)).toEqual([
      "video",
      "file",
      "file",
    ]);
  });
});

describe("parseEventCallback", (): void => {
  const mention = {
    type: "app_mention",
    text: "<@BOT> hi",
    channel: "C1",
    channel_type: "channel",
    user: "U1",
    ts: "1713916800.000001",
  };

  test("ignores an envelope with no event id", async (): Promise<void> => {
    const parsed = await parseEvent(mention, { event_id: "" });

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "invalid_event_callback",
    });
  });

  test("ignores an event with no channel", async (): Promise<void> => {
    const parsed = await parseEvent({ ...mention, channel: undefined });

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "missing_channel_or_timestamp",
    });
  });

  test("ignores a channel outside the allow list", async (): Promise<void> => {
    const parsed = await parseEvent(mention, {}, new Set(["C9"]));

    expect(parsed).toEqual({ kind: "ignore", reason: "channel_not_allowed" });
  });

  test("ignores a sender outside the allow list", async (): Promise<void> => {
    const parsed = await parseEvent(mention, {}, null, new Set(["U9"]));

    expect(parsed).toEqual({ kind: "ignore", reason: "user_not_allowed" });
  });
});

describe("mentionsSlackBot", (): void => {
  test("lets a channel message that mentions someone else through as context", async (): Promise<void> => {
    const parsed = await parseEvent(
      {
        type: "message",
        text: "<@U2> can you look?",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000003",
      },
      { authorizations: [{ user_id: "BOT", is_bot: true }] },
    );

    expect(parsed.kind).toBe("context");
  });
});

describe("getUnsupportedSlackEventReason", (): void => {
  const base = {
    text: "x",
    channel: "C1",
    user: "U1",
    ts: "1713916800.000002",
  };

  test("names a bot message", async (): Promise<void> => {
    const parsed = await parseEvent({
      ...base,
      type: "message",
      channel_type: "channel",
      bot_id: "B1",
    });

    expect(parsed).toEqual({ kind: "ignore", reason: "bot_message" });
  });

  test("names an unsupported message channel", async (): Promise<void> => {
    const parsed = await parseEvent({
      ...base,
      type: "message",
      channel_type: "weird",
    });

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "unsupported_message_channel:weird",
    });
  });

  test("names an unsupported event type", async (): Promise<void> => {
    const parsed = await parseEvent({ ...base, type: "reaction_added" });

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "unsupported_event:reaction_added",
    });
  });
});

describe("parseSlashCommand", (): void => {
  test("ignores a command with no team", async (): Promise<void> => {
    const parsed = await parseSlash("channel_id=C1&command=%2Fnew&user_id=U1");

    expect(parsed).toEqual({ kind: "ignore", reason: "invalid_slash_command" });
  });

  test("ignores a channel outside the allow list", async (): Promise<void> => {
    const parsed = await parseSlash(
      "team_id=T1&channel_id=C1&command=%2Fnew&user_id=U1",
      new Set(["C9"]),
    );

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "slash_command_channel_not_allowed",
    });
  });

  test("ignores a sender outside the allow list", async (): Promise<void> => {
    const parsed = await parseSlash(
      "team_id=T1&channel_id=C1&command=%2Fnew&user_id=U1",
      null,
      new Set(["U9"]),
    );

    expect(parsed).toEqual({
      kind: "ignore",
      reason: "slash_command_user_not_allowed",
    });
  });
});

describe("toSlackStream", (): void => {
  test("passes Slack stream chunks through and drops malformed ones", async (): Promise<void> => {
    const chunks = await collect(
      toSlackStream(
        (async function* (): AsyncGenerator<unknown> {
          yield { type: "markdown_text", text: "hello" };
          yield { type: "markdown_text", text: 5 };
          yield {
            type: "task_update",
            id: "a",
            title: "T",
            status: "complete",
          };
          yield { type: "task_update", id: "a", title: "T" };
          yield { type: "plan_update", title: "Plan" };
          yield { type: "plan_update", title: 3 };
        })(),
      ),
    );

    expect(chunks).toEqual([
      { type: "markdown_text", text: "hello" },
      { type: "task_update", id: "a", title: "T", status: "complete" },
      { type: "plan_update", title: "Plan" },
    ]);
  });

  test("formats tool output as text, JSON, blank or unserializable", async (): Promise<void> => {
    const chunks = await collect(
      toSlackStream(
        (async function* (): AsyncGenerator<unknown> {
          yield {
            type: "tool-result",
            toolCallId: "1",
            toolName: "a",
            output: null,
          };
          yield {
            type: "tool-result",
            toolCallId: "2",
            toolName: "a",
            output: [1, "b"],
          };
          yield {
            type: "tool-result",
            toolCallId: "3",
            toolName: "a",
            output: 12n,
          };
        })(),
      ),
    );

    expect(
      chunks.map((c): string | null =>
        typeof c === "string" ? c : "output" in c ? c.output : null,
      ),
    ).toEqual(["", '[1,"b"]', "[unserializable tool output]"]);
  });

  test("joins the text of two final steps with a blank line", async (): Promise<void> => {
    const chunks = await collect(
      toSlackStream(
        (async function* (): AsyncGenerator<unknown> {
          yield { type: "text-delta", text: "one" };
          yield { type: "finish-step", finishReason: "stop" };
          yield { type: "text-delta", text: "two" };
          yield { type: "finish-step", finishReason: "stop" };
        })(),
      ),
    );

    expect(chunks).toEqual(["one\n\ntwo"]);
  });
});
