/**
 * Slack channel adapter tests.
 * Cover signature verification and event/slash-command normalization here.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createHmac } from "node:crypto";
import { createSlackChannel } from "../functions/_shared/slack-channel.ts";

describe("slack channel adapter", () => {
  beforeEach(() => {
    setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
  });

  afterEach(() => {
    setSystemTime();
  });

  it("authenticates valid signatures and rejects stale timestamps", () => {
    const adapter = createSlackChannel("bot-token", "signing-secret", null);
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

    expect(adapter.authenticate(request)).toBe(true);

    expect(adapter.authenticate({
      ...request,
      headers: {
        ...request.headers,
        "x-slack-request-timestamp": `${Math.floor(new Date("2026-04-24T00:00:00.000Z").getTime() / 1000) - 301}`,
      },
    })).toBe(false);
  });

  it("responds to url_verification challenges", () => {
    const adapter = createSlackChannel("bot-token", "signing-secret", null);

    const parsed = adapter.parse(createEventRequest({
      type: "url_verification",
      challenge: "challenge-token",
    }));

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected Slack URL verification to return a response");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toBe(JSON.stringify({ challenge: "challenge-token" }));
  });

  it("normalizes app mentions into threaded conversations and strips bot mentions", () => {
    const adapter = createSlackChannel("bot-token", "signing-secret", new Set(["C1"]));

    const parsed = adapter.parse(createEventRequest({
      type: "event_callback",
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
    expect(parsed.message.eventId).toBe("slack:evt-2");
    expect(parsed.message.conversationKey).toBe("slack:T1:C1:1713916800.000002");
    expect(parsed.message.content).toEqual([{ type: "text", text: "hello there" }]);
    expect(parsed.message.source).toEqual({
      teamId: "T1",
      channelId: "C1",
      messageTs: "1713916800.000002",
      threadTs: "1713916800.000002",
      userId: "U1",
    });
  });

  it("keeps direct messages channel-scoped instead of thread-scoped", () => {
    const adapter = createSlackChannel("bot-token", "signing-secret", null);

    const parsed = adapter.parse(createEventRequest({
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
    expect(parsed.message.source).toEqual({
      teamId: "T1",
      channelId: "D1",
      messageTs: "1713916800.000003",
      threadTs: undefined,
      userId: "U1",
    });
  });

  it("normalizes slash commands and carries the command token in source", () => {
    const adapter = createSlackChannel("bot-token", "signing-secret", new Set(["C1"]));

    const parsed = adapter.parse(createSlashCommandRequest(
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

function createEventRequest(
  payload: Record<string, unknown>,
  timestamp: string = "1776988800",
) {
  const body = JSON.stringify(payload);
  return {
    method: "POST",
    rawPath: "/",
    headers: createSlackHeaders(body, timestamp),
    body,
  };
}

function createSlashCommandRequest(body: string, timestamp: string = "1776988800") {
  return {
    method: "POST",
    rawPath: "/",
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
