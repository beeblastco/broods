/**
 * Slack channel adapter tests.
 * Cover signature verification and event/slash-command normalization here.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHmac } from "node:crypto";
import { createSlackChannel, toSlackStream } from "../src/shared/slack-channel.ts";

describe("slack channel adapter", () => {
  beforeEach(() => {
    setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
  });

  afterEach(() => {
    setSystemTime();
  });

  it("authenticates valid signatures and rejects stale timestamps", async () => {
    const adapter = createTestSlackChannel(null);
    const request = createEventRequest({
      type: "event_callback",
      event_id: "evt-1",
      team_id: "T1",
      event: {
        type: "app_mention",
        text: "<@BOT> hello",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000001",
      },
    }, "1776988800");

    await expect(adapter.authenticate(request)).resolves.toBe(true);

    await expect(adapter.authenticate({
      ...request,
      headers: {
        ...request.headers,
        "x-slack-request-timestamp": `${Math.floor(new Date("2026-04-24T00:00:00.000Z").getTime() / 1000) - 301}`,
      },
    })).resolves.toBe(false);
  });

  it("responds to url_verification challenges", async () => {
    const adapter = createTestSlackChannel(null);

    const parsed = await adapter.parse(createEventRequest({
      type: "url_verification",
      challenge: "challenge-token",
    }));

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected Slack URL verification to return a response");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.reason).toBe("url_verification");
    expect(parsed.response.body).toBe(JSON.stringify({ challenge: "challenge-token" }));
  });

  it("stores public channel messages as thread-scoped context", async () => {
    const adapter = createTestSlackChannel(null);

    const parsed = await adapter.parse(createEventRequest({
      type: "event_callback",
      event_id: "evt-channel",
      team_id: "T1",
      event: {
        type: "message",
        text: "hello channel",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000004",
      },
    }));

    expect(parsed.kind).toBe("context");
    if (parsed.kind !== "context") {
      throw new Error("Expected public channel message to be stored as context");
    }

    expect(parsed.message.conversationKey).toBe("slack:T1:C1:1713916800.000004");
    // Group-channel messages include the sender's user id so the agent knows
    // who is talking in a multi-user channel.
    expect(parsed.message.content).toEqual([{ type: "text", text: "Alex: hello channel" }]);
    expect(parsed.message.source).toEqual({
      teamId: "T1",
      channelId: "C1",
      messageTs: "1713916800.000004",
      threadTs: "1713916800.000004",
      userId: "U1",
    });
  });

  it("keeps root context and later thread mentions in the same Slack conversation", async () => {
    const adapter = createTestSlackChannel(null);

    const root = await adapter.parse(createEventRequest({
      type: "event_callback",
      event_id: "evt-root",
      team_id: "T1",
      event: {
        type: "message",
        text: "Here is the customer list screenshot.",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000020",
      },
    }));
    const mention = await adapter.parse(createEventRequest({
      type: "event_callback",
      authorizations: [{ user_id: "BOT", is_bot: true }],
      event_id: "evt-thread-mention",
      team_id: "T1",
      event: {
        type: "app_mention",
        text: "<@BOT> summarize this",
        channel: "C1",
        channel_type: "channel",
        user: "U2",
        thread_ts: "1713916800.000020",
        ts: "1713916800.000021",
      },
    }));

    expect(root.kind).toBe("context");
    expect(mention.kind).toBe("message");
    if (root.kind !== "context" || mention.kind !== "message") {
      throw new Error("Expected root context and thread mention");
    }
    expect(root.message.conversationKey).toBe("slack:T1:C1:1713916800.000020");
    expect(mention.message.conversationKey).toBe(root.message.conversationKey);
    expect(mention.message.source.threadTs).toBe("1713916800.000020");
  });

  it("stores generic message events with human mentions as context", async () => {
    const adapter = createTestSlackChannel(null);

    const parsed = await adapter.parse(createEventRequest({
      type: "event_callback",
      event_id: "evt-mentions",
      team_id: "T1",
      event: {
        type: "message",
        text: "Hey <@U2> and <@U3>, what do you think?",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000010",
      },
    }));

    expect(parsed.kind).toBe("context");
    if (parsed.kind !== "context") {
      throw new Error("Expected human mentions to be preserved as channel context");
    }
    expect(parsed.message.content).toEqual([{ type: "text", text: "Alex: Hey @Blair and @Casey, what do you think?" }]);
  });

  it("explains ignored Slack message subtypes", async () => {
    const adapter = createTestSlackChannel(null);

    const parsed = await adapter.parse(createEventRequest({
      type: "event_callback",
      event_id: "evt-ignored",
      team_id: "T1",
      event: {
        type: "message",
        subtype: "message_changed",
        text: "hello channel",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000005",
      },
    }));

    expect(parsed.kind).toBe("ignore");
    if (parsed.kind !== "ignore") {
      throw new Error("Expected message subtype to be ignored");
    }

    expect(parsed.reason).toBe("unsupported_subtype:message_changed");
  });

  it("normalizes app mentions into thread-scoped conversations and strips the bot mention", async () => {
    const adapter = createTestSlackChannel(new Set(["C1"]));

    const parsed = await adapter.parse(createEventRequest({
      type: "event_callback",
      authorizations: [{ user_id: "BOT", is_bot: true }],
      event_id: "evt-2",
      team_id: "T1",
      event: {
        type: "app_mention",
        text: "<@BOT> hello there",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000002",
      },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Slack app mention to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200 });
    // Both app_mention and message events for the same user message share the
    // same ts, so using ts as the eventId lets session.claim() dedupe them.
    expect(parsed.message.eventId).toBe("slack:T1:C1:1713916800.000002");
    expect(parsed.message.conversationKey).toBe("slack:T1:C1:1713916800.000002");
    expect(parsed.message.content).toEqual([{ type: "text", text: "Alex: hello there" }]);
    expect(parsed.message.source).toEqual({
      teamId: "T1",
      channelId: "C1",
      messageTs: "1713916800.000002",
      threadTs: "1713916800.000002",
      userId: "U1",
    });
  });

  it("deduplicates app_mention and message events with the same ts", async () => {
    const adapter = createTestSlackChannel(new Set(["C1"]));

    const mention = await adapter.parse(createEventRequest({
      type: "event_callback",
      event_id: "evt-mention",
      team_id: "T1",
      event: {
        type: "app_mention",
        text: "<@BOT> hello",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000099",
      },
    }));

    const message = await adapter.parse(createEventRequest({
      type: "event_callback",
      authorizations: [{ user_id: "BOT", is_bot: true }],
      event_id: "evt-message",
      team_id: "T1",
      event: {
        type: "message",
        text: "<@BOT> hello",
        channel: "C1",
        channel_type: "channel",
        user: "U1",
        ts: "1713916800.000099",
      },
    }));

    expect(mention.kind).toBe("message");
    expect(message.kind).toBe("ignore");
    if (mention.kind !== "message" || message.kind !== "ignore") {
      throw new Error("Expected app_mention to run and generic message duplicate to be ignored");
    }
    expect(message.reason).toBe("message_with_mention_wait_for_app_mention");
  });

  it("maps AI SDK full stream progress into Slack task updates", async () => {
    const chunks = await collect(toSlackStream((async function* () {
      yield { type: "reasoning-start", id: "r1" };
      yield { type: "reasoning-delta", id: "r1", text: "checking context" };
      yield { type: "reasoning-end", id: "r1" };
      yield { type: "tool-input-start", id: "tc1", toolName: "bash" };
      yield { type: "tool-call", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } };
      yield { type: "tool-result", toolCallId: "tc1", toolName: "bash", output: "done" };
      yield { type: "text-delta", id: "t1", text: "final" };
    })()));

    expect(chunks).toEqual([
      { type: "task_update", id: "reasoning:r1", title: "Thinking", status: "in_progress" },
      { type: "task_update", id: "reasoning:r1", title: "Thinking", status: "in_progress", details: "checking context" },
      { type: "task_update", id: "reasoning:r1", title: "Thinking", status: "complete", output: "checking context" },
      { type: "task_update", id: "tool:tc1", title: "Using bash", status: "in_progress" },
      { type: "task_update", id: "tool:tc1", title: "Using bash", status: "in_progress" },
      { type: "task_update", id: "tool:tc1", title: "Using bash", status: "complete", output: "done" },
      "final",
    ]);
  });

  it("keeps direct messages channel-scoped instead of thread-scoped", async () => {
    const adapter = createTestSlackChannel(null);

    const parsed = await adapter.parse(createEventRequest({
      type: "event_callback",
      event_id: "evt-3",
      team_id: "T1",
      event: {
        type: "message",
        text: "hello dm",
        channel: "D1",
        channel_type: "im",
        user: "U1",
        ts: "1713916800.000003",
      },
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Slack DM message to be accepted");
    }

    expect(parsed.message.conversationKey).toBe("slack:T1:D1");
    // DMs are not prefixed with the user id because there is only one user.
    expect(parsed.message.content).toEqual([{ type: "text", text: "hello dm" }]);
    expect(parsed.message.source).toEqual({
      teamId: "T1",
      channelId: "D1",
      messageTs: "1713916800.000003",
      threadTs: undefined,
      userId: "U1",
    });
  });

  it("normalizes slash commands and carries the command token in source", async () => {
    const adapter = createTestSlackChannel(new Set(["C1"]));

    const parsed = await adapter.parse(createSlashCommandRequest(
      "team_id=T1&channel_id=C1&command=%2Fnew&text=reset+context&user_id=U1&response_url=https%3A%2F%2Fslack.example%2Fresponse",
    ));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected Slack slash command to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200 });
    expect(parsed.message.eventId).toBe("slack-command:T1:C1:/new:reset context");
    expect(parsed.message.conversationKey).toBe("slack:T1:C1");
    expect(parsed.message.content).toEqual([{ type: "text", text: "reset context" }]);
    expect(parsed.message.source).toEqual({
      teamId: "T1",
      channelId: "C1",
      responseUrl: "https://slack.example/response",
      commandToken: "/new",
      userId: "U1",
    });
  });
});

function createTestSlackChannel(allowedChannelIds: Set<string> | null) {
  const users = new Map([
    ["U1", "Alex"],
    ["U2", "Blair"],
    ["U3", "Casey"],
    ["BOT", "Broods"],
  ]);

  return createSlackChannel(
    "bot-token",
    "signing-secret",
    allowedChannelIds,
    "eyes",
    undefined,
    async (userId) => users.get(userId) ?? null,
  );
}

function createEventRequest(
  payload: Record<string, unknown>,
  timestamp: string = "1776988800",
) {
  const body = JSON.stringify(payload);
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: "",
    headers: createSlackHeaders(body, timestamp),
    body,
  };
}

function createSlashCommandRequest(body: string, timestamp: string = "1776988800") {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: "",
    headers: {
      ...createSlackHeaders(body, timestamp),
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  };
}

function createSlackHeaders(body: string, timestamp: string): Record<string, string> {
  const signature = `v0=${createHmac("sha256", "signing-secret")
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;

  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": signature,
    "content-type": "application/json",
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}
