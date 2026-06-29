/**
 * Slack channel adapter.
 * Handle request verification, inbound normalization, and Slack Web API reply actions here.
 */

import {
  assertSlackOk,
  callSlackApi,
  postSlackMessage,
  sendSlackResponseUrl,
  SlackApiError,
} from "@chat-adapter/slack/api";
import {
  SlackAdapter,
  SlackFormatConverter,
  type SlackEvent,
  type SlackThreadId,
} from "@chat-adapter/slack";
import {
  parseSlackWebhookBody,
  verifySlackSignature,
  type SlackSlashCommandPayload,
} from "@chat-adapter/slack/webhook";
import { ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult
} from "./channels.ts";
import { logWarn } from "./log.ts";
import {
  SLACK_COMMAND_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
} from "./runtime-keys.ts";

interface SlackEventEnvelope {
  challenge?: string;
  event?: SlackEvent;
  event_id?: string;
  team_id?: string;
  type?: string;
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
  reactionEmoji = "eyes",
  apiUrl?: string,
): ChannelAdapter {
  const slack = new SlackAdapter({
    apiUrl,
    botToken,
    signingSecret,
    mode: "webhook",
    logger: new ConsoleLogger("error").child("slack"),
  });

  return {
    name: "slack",

    canHandle(req) {
      return "x-slack-signature" in req.headers;
    },

    async authenticate(req) {
      try {
        await verifySlackSignature(req.body, req.headers, { signingSecret });
        return true;
      } catch (err) {
        logWarn("Slack request signature verification failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },

    parse(req): ChannelParseResult {
      const payload = parseSlackWebhookBody(req.body, { headers: req.headers });

      if (payload.kind === "url_verification") {
        return {
          kind: "response",
          reason: "url_verification",
          response: {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ challenge: payload.challenge }),
          },
        };
      }

      if (payload.kind === "slash_command") {
        return parseSlashCommand(payload, allowedChannelIds);
      }

      if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
        return { kind: "ignore", reason: `unsupported_slack_payload:${payload.kind}` };
      }

      return parseEventCallback(req.body, allowedChannelIds);
    },

    actions(msg): ChannelActions {
      return createSlackActions(botToken, slack, toSlackSource(msg.source), reactionEmoji);
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
      reason: "url_verification",
      response: {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: payload.challenge }),
      },
    };
  }

  if (payload.type !== "event_callback" || !isSlackMessageEvent(payload.event) || !payload.event_id || !payload.team_id) {
    return { kind: "ignore", reason: "invalid_event_callback" };
  }

  if (!isSupportedSlackEvent(payload.event)) {
    return { kind: "ignore", reason: getUnsupportedSlackEventReason(payload.event) };
  }

  const channelId = payload.event.channel;
  const ts = payload.event.ts;
  if (!channelId || !ts) {
    return { kind: "ignore", reason: "missing_channel_or_timestamp" };
  }

  if (allowedChannelIds && !allowedChannelIds.has(channelId)) {
    logWarn("Slack channel not in allow list", { channelId });
    return { kind: "ignore", reason: "channel_not_allowed" };
  }

  const text = stripSlackMentions(payload.event.text ?? "");
  const threadTs = payload.event.thread_ts ?? ts;
  const replyThreadTs = getSlackReplyThreadTs(payload.event, ts);

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${SLACK_INTEGRATION_PREFIX}${payload.event_id}`,
      conversationKey: getSlackConversationKey(payload.team_id, channelId, payload.event, threadTs),
      channelName: "slack",
      content: [{ type: "text", text }],
      source: {
        teamId: payload.team_id,
        channelId,
        messageTs: ts,
        threadTs: replyThreadTs,
        userId: payload.event.user,
      } satisfies SlackSource,
    },
  };
}

function isSlackMessageEvent(event: SlackEvent | undefined): event is SlackEvent {
  return Boolean(event && "type" in event && typeof event.type === "string");
}

function isSupportedSlackEvent(event: SlackEvent): boolean {
  if (event.subtype || event.bot_id) {
    return false;
  }

  if (event.type === "app_mention") {
    return true;
  }

  return event.type === "message" && isSupportedSlackMessageChannel(event.channel_type);
}

function getUnsupportedSlackEventReason(event: SlackEvent): string {
  if (event.bot_id) return "bot_message";
  if (event.subtype) return `unsupported_subtype:${event.subtype}`;
  if (event.type === "message") return `unsupported_message_channel:${event.channel_type ?? "unknown"}`;

  return `unsupported_event:${event.type ?? "unknown"}`;
}

function isSupportedSlackMessageChannel(channelType: string | undefined): boolean {
  return channelType === "channel"
    || channelType === "group"
    || channelType === "mpim"
    || channelType === "im"
    || channelType === "app_home";
}

function getSlackConversationKey(
  teamId: string,
  channelId: string,
  event: SlackEvent,
  threadTs: string,
): string {
  if (event.type === "message" && (event.channel_type === "im" || event.channel_type === "app_home")) {
    return `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}`;
  }

  return `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}:${threadTs}`;
}

function getSlackReplyThreadTs(
  event: SlackEvent,
  messageTs: string,
): string | undefined {
  if (
    event.type === "app_mention" ||
    (event.type === "message" && event.channel_type !== "im" && event.channel_type !== "app_home")
  ) {
    return event.thread_ts ?? messageTs;
  }

  return event.thread_ts;
}

function parseSlashCommand(
  payload: SlackSlashCommandPayload,
  allowedChannelIds: Set<string> | null,
): ChannelParseResult {
  const teamId = payload.teamId;
  const channelId = payload.channelId;
  const command = payload.command;

  if (!teamId || !channelId || !command) {
    return { kind: "ignore", reason: "invalid_slash_command" };
  }

  if (allowedChannelIds && !allowedChannelIds.has(channelId)) {
    logWarn("Slack slash command channel not in allow list", { channelId });
    return { kind: "ignore", reason: "slash_command_channel_not_allowed" };
  }

  const text = payload.text ?? "";

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${SLACK_COMMAND_INTEGRATION_PREFIX}${payload.triggerId ?? `${teamId}:${channelId}:${command}:${text}`}`,
      conversationKey: `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}`,
      channelName: "slack",
      content: [{ type: "text", text }],
      source: {
        teamId,
        channelId,
        responseUrl: payload.responseUrl,
        commandToken: command,
        userId: payload.userId,
      } satisfies SlackSource,
    },
  };
}

function createSlackActions(
  botToken: string,
  slack: SlackAdapter,
  source: SlackSource,
  reactionEmoji: string,
): ChannelActions {
  const threadId = source.threadTs
    ? slack.encodeThreadId({ channel: source.channelId, threadTs: source.threadTs } satisfies SlackThreadId)
    : undefined;
  const formatter = new SlackFormatConverter();

  return {
    async sendText(text) {
      if (source.responseUrl) {
        await sendSlackWebhookResponse(source.responseUrl, formatter.toResponseUrlText({ markdown: text }));
        return;
      }

      try {
        await postSlackMessage({
          token: botToken,
          channel: source.channelId,
          markdownText: text,
          threadTs: source.threadTs,
          unfurlLinks: false,
          unfurlMedia: false,
        });
      } catch (err) {
        throw normalizeSlackApiError("chat.postMessage", err);
      }
    },

    async sendTyping() {
      return;
    },

    async reactToMessage() {
      if (!source.messageTs) {
        return;
      }

      try {
        assertSlackOk("reactions.add", await callSlackApi(
          "reactions.add",
          {
            channel: source.channelId,
            timestamp: source.messageTs,
            name: reactionEmoji,
          },
          { token: botToken, contentType: "json" },
        ));
      } catch (err) {
        throw normalizeSlackApiError("reactions.add", err);
      }
    },

    ...(threadId && source.userId
      ? {
        stream: async (textStream, options) => {
          const result = await slack.stream(threadId, textStream, {
            ...options,
            recipientTeamId: source.teamId,
            recipientUserId: source.userId!,
          });
          return result.id;
        },
      }
      : {}),
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

function normalizeSlackApiError(method: string, err: unknown): Error {
  if (err instanceof SlackApiError) {
    return new Error(
      `Slack ${method} failed (${err.status ?? 200}): ${err.response?.error ?? "unknown_error"}`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function sendSlackWebhookResponse(
  url: string,
  text: string,
): Promise<void> {
  try {
    await sendSlackResponseUrl(url, {
      text,
      responseType: "in_channel",
    });
  } catch (err) {
    if (err instanceof SlackApiError) {
      throw new Error(`Slack response_url failed (${err.status ?? 0})`);
    }
    throw err;
  }
}

function stripSlackMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}
