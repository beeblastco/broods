/**
 * Slack channel adapter.
 * Handle request verification, inbound normalization, and Slack Web API reply actions here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult
} from "./channels.ts";
import { logWarn } from "./log.ts";

interface SlackEventEnvelope {
  type: string;
  event_id?: string;
  team_id?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    text?: string;
    channel?: string;
    user?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export interface SlackSource {
  teamId: string;
  channelId: string;
  threadTs?: string;
  messageTs?: string;
  responseUrl?: string;
  commandToken?: string;
  userId?: string;
}

export function createSlackChannel(
  botToken: string,
  signingSecret: string,
  allowedChannelIds: Set<string> | null,
): ChannelAdapter {
  return {
    name: "slack",

    canHandle(req) {
      return "x-slack-signature" in req.headers;
    },

    authenticate(req) {
      const timestamp = req.headers["x-slack-request-timestamp"];
      const signature = req.headers["x-slack-signature"];
      if (!timestamp || !signature) {
        return false;
      }

      const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
      if (!Number.isFinite(ageSeconds) || ageSeconds > 60 * 5) {
        logWarn("Slack request timestamp outside replay window");
        return false;
      }

      const base = `v0:${timestamp}:${req.body}`;
      const expected = `v0=${createHmac("sha256", signingSecret).update(base).digest("hex")}`;
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);

      return actualBytes.length === expectedBytes.length
        && timingSafeEqual(actualBytes, expectedBytes);
    },

    parse(req): ChannelParseResult {
      const contentType = req.headers["content-type"] ?? "";

      if (contentType.includes("application/x-www-form-urlencoded")) {
        return parseSlashCommand(req.body, allowedChannelIds);
      }

      return parseEventCallback(req.body, allowedChannelIds);
    },

    actions(msg): ChannelActions {
      return createSlackActions(botToken, toSlackSource(msg.source));
    },
  };
}

function parseEventCallback(
  body: string,
  allowedChannelIds: Set<string> | null,
): ChannelParseResult {
  const payload = JSON.parse(body) as SlackEventEnvelope;

  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return {
      kind: "response",
      response: {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: payload.challenge }),
      },
    };
  }

  if (payload.type !== "event_callback" || !payload.event || !payload.event_id || !payload.team_id) {
    return { kind: "ignore" };
  }

  if (payload.event.type !== "app_mention" || payload.event.subtype) {
    return { kind: "ignore" };
  }

  const channelId = payload.event.channel;
  const ts = payload.event.ts;
  if (!channelId || !ts) {
    return { kind: "ignore" };
  }

  if (allowedChannelIds && !allowedChannelIds.has(channelId)) {
    logWarn("Slack channel not in allow list", { channelId });
    return { kind: "ignore" };
  }

  const text = stripSlackMentions(payload.event.text ?? "");
  const threadTs = payload.event.thread_ts ?? ts;

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `slack:${payload.event_id}`,
      conversationKey: `slack:${payload.team_id}:${channelId}:${threadTs}`,
      channelName: "slack",
      content: [{ type: "text", text }],
      source: {
        teamId: payload.team_id,
        channelId,
        messageTs: ts,
        threadTs,
        userId: payload.event.user,
      } satisfies SlackSource,
    },
  };
}

function parseSlashCommand(
  body: string,
  allowedChannelIds: Set<string> | null,
): ChannelParseResult {
  const params = new URLSearchParams(body);
  const teamId = params.get("team_id");
  const channelId = params.get("channel_id");
  const command = params.get("command");

  if (!teamId || !channelId || !command) {
    return { kind: "ignore" };
  }

  if (allowedChannelIds && !allowedChannelIds.has(channelId)) {
    logWarn("Slack slash command channel not in allow list", { channelId });
    return { kind: "ignore" };
  }

  const text = params.get("text") ?? "";

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `slack-command:${params.get("trigger_id") ?? `${teamId}:${channelId}:${command}:${text}`}`,
      conversationKey: `slack:${teamId}:${channelId}`,
      channelName: "slack",
      content: [{ type: "text", text }],
      source: {
        teamId,
        channelId,
        responseUrl: params.get("response_url") ?? undefined,
        commandToken: command,
        userId: params.get("user_id") ?? undefined,
      } satisfies SlackSource,
    },
  };
}

function createSlackActions(
  botToken: string,
  source: SlackSource,
): ChannelActions {
  return {
    async sendText(text) {
      if (source.responseUrl) {
        const response = await fetch(source.responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, response_type: "in_channel" }),
        });
        if (!response.ok) {
          throw new Error(`Slack response_url failed (${response.status})`);
        }
        return;
      }

      await slackApi(botToken, "chat.postMessage", {
        channel: source.channelId,
        text,
        ...(source.threadTs ? { thread_ts: source.threadTs } : {}),
      });
    },

    async sendTyping() {
      return;
    },

    async reactToMessage() {
      if (!source.messageTs) {
        return;
      }

      await slackApi(botToken, "reactions.add", {
        channel: source.channelId,
        timestamp: source.messageTs,
        name: "eyes",
      });
    },
  };
}

function toSlackSource(source: Record<string, unknown>): SlackSource {
  if (
    typeof source.teamId !== "string" ||
    typeof source.channelId !== "string"
  ) {
    throw new Error("Invalid Slack source payload");
  }

  return {
    teamId: source.teamId,
    channelId: source.channelId,
    threadTs: typeof source.threadTs === "string" ? source.threadTs : undefined,
    messageTs: typeof source.messageTs === "string" ? source.messageTs : undefined,
    responseUrl: typeof source.responseUrl === "string" ? source.responseUrl : undefined,
    commandToken: typeof source.commandToken === "string" ? source.commandToken : undefined,
    userId: typeof source.userId === "string" ? source.userId : undefined,
  };
}

async function slackApi(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  const json = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || !json.ok) {
    throw new Error(
      `Slack ${method} failed (${response.status}): ${json.error ?? "unknown_error"}`,
    );
  }
}

function stripSlackMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}
