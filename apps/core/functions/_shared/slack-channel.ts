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
import { ConsoleLogger, type StreamChunk } from "chat";
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
  authorizations?: Array<{ user_id?: string; is_bot?: boolean }>;
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

  if (payload.event.type === "message" && mentionsSlackBot(payload.event.text ?? "", payload)) {
    return { kind: "ignore", reason: "message_with_mention_wait_for_app_mention" };
  }

  const isGroupChannel = payload.event.channel_type !== "im" && payload.event.channel_type !== "app_home";
  const text = formatSlackMessageText(payload.event.text ?? "", payload.event.user, isGroupChannel);
  const threadTs = payload.event.thread_ts ?? ts;
  const replyThreadTs = getSlackReplyThreadTs(payload.event, ts);
  const runAgent = payload.event.type === "app_mention"
    || payload.event.channel_type === "im"
    || payload.event.channel_type === "app_home";

  return {
    kind: runAgent ? "message" : "context",
    ack: { statusCode: 200 },
    message: {
      // Use team:channel:ts as the eventId so that duplicate Slack deliveries
      // (app_mention + message for the same mention) dedupe naturally via
      // session.claim().  ts is unique per message within a channel.
      eventId: `${SLACK_INTEGRATION_PREFIX}${payload.team_id}:${channelId}:${ts}`,
      conversationKey: getSlackConversationKey(payload.team_id, channelId),
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

function getSlackConversationKey(teamId: string, channelId: string): string {
  // Channel-scoped for all channel types so the agent sees every message in
  // the channel/thread, not just the ones in a single thread branch.
  return `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}`;
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
          const result = await slack.stream(threadId, toSlackStream(textStream), {
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

/**
 * Convert Slack mrkdwn mention syntax `<@U123>` into `@U123` so the LLM can
 * understand who was mentioned.  Preserves all mentions (including the bot's)
 * rather than stripping them.
 */
function normalizeSlackMentions(text: string): string {
  return text.replace(/<@([^>]+)>/g, "@$1").trim();
}

function hasSlackMention(text: string): boolean {
  return /<@[^>]+>/.test(text);
}

function mentionsSlackBot(text: string, payload: SlackEventEnvelope): boolean {
  const botUserIds = new Set(
    (payload.authorizations ?? [])
      .filter((authorization) => authorization.is_bot !== false)
      .map((authorization) => authorization.user_id)
      .filter((userId): userId is string => typeof userId === "string" && userId.length > 0),
  );
  if (botUserIds.size === 0 || !hasSlackMention(text)) {
    return false;
  }

  for (const [, mentionedUserId] of text.matchAll(/<@([^>]+)>/g)) {
    if (mentionedUserId && botUserIds.has(mentionedUserId)) {
      return true;
    }
  }

  return false;
}

/**
 * Prefix a group-channel message with the sender's user identifier so the
 * agent knows who is talking when multiple users are in the conversation.
 * DMs and app_home messages are not prefixed because there is only one user.
 */
function formatSlackMessageText(text: string, userId: string | undefined, isGroupChannel: boolean): string {
  const normalized = normalizeSlackMentions(text);
  if (!isGroupChannel || !userId || !normalized) {
    return normalized;
  }
  return `@${userId}: ${normalized}`;
}

/**
 * Converts the AI SDK full stream into Slack Chat SDK chunks. Plain text remains
 * incremental markdown, while reasoning and tool events become native task
 * updates so Slack can show progress cards instead of only the final text.
 */
export async function* toSlackStream(
  textStream: AsyncIterable<unknown>,
): AsyncGenerator<string | StreamChunk> {
  let needsSeparator = false;
  let hasEmittedText = false;
  let reasoningText = "";
  const toolNamesById = new Map<string, string>();

  for await (const chunk of textStream) {
    if (typeof chunk === "string") {
      yield chunk;
      continue;
    }

    if (!chunk || typeof chunk !== "object") {
      continue;
    }

    const event = chunk as Record<string, unknown>;
    const type = event.type;

    if (isStreamChunk(event)) {
      yield event;
      continue;
    }

    switch (type) {
      case "text-delta": {
        const text = (event.text ?? event.delta ?? "") as string;
        if (text) {
          if (needsSeparator && hasEmittedText) {
            yield "\n\n";
          }
          needsSeparator = false;
          hasEmittedText = true;
          yield text;
        }
        break;
      }

      case "finish-step": {
        needsSeparator = true;
        break;
      }

      case "reasoning-start": {
        reasoningText = "";
        yield {
          type: "task_update",
          id: taskId("reasoning", event.id),
          title: "Thinking",
          status: "in_progress",
        };
        break;
      }

      case "reasoning-delta": {
        const text = (event.text ?? event.delta ?? "") as string;
        if (text) {
          reasoningText = truncateForSlackTask(`${reasoningText}${text}`);
          yield {
            type: "task_update",
            id: taskId("reasoning", event.id),
            title: "Thinking",
            status: "in_progress",
            details: reasoningText,
          };
        }
        break;
      }

      case "reasoning-end": {
        yield {
          type: "task_update",
          id: taskId("reasoning", event.id),
          title: "Thinking",
          status: "complete",
          ...(reasoningText ? { output: reasoningText } : {}),
        };
        reasoningText = "";
        break;
      }

      case "tool-input-start": {
        const toolName = (event.toolName ?? "tool") as string;
        const id = stringValue(event.id) ?? toolName;
        toolNamesById.set(id, toolName);
        yield {
          type: "task_update",
          id: taskId("tool", id),
          title: `Using ${toolName}`,
          status: "in_progress",
        };
        break;
      }

      case "tool-input-delta": {
        // Ignore input deltas; we already announced the tool call.
        break;
      }

      case "tool-call": {
        const toolName = (event.toolName ?? "tool") as string;
        const id = stringValue(event.toolCallId) ?? stringValue(event.id) ?? toolName;
        toolNamesById.set(id, toolName);
        yield {
          type: "task_update",
          id: taskId("tool", id),
          title: `Using ${toolName}`,
          status: "in_progress",
        };
        break;
      }

      case "tool-result": {
        const id = stringValue(event.toolCallId) ?? stringValue(event.id) ?? "tool";
        const toolName = (event.toolName ?? toolNamesById.get(id) ?? "tool") as string;
        yield {
          type: "task_update",
          id: taskId("tool", id),
          title: `Using ${toolName}`,
          status: "complete",
          output: truncateForSlackTask(formatToolOutput(event.output)),
        };
        toolNamesById.delete(id);
        break;
      }

      case "tool-error": {
        const id = stringValue(event.toolCallId) ?? stringValue(event.id) ?? "tool";
        const toolName = (event.toolName ?? toolNamesById.get(id) ?? "tool") as string;
        yield {
          type: "task_update",
          id: taskId("tool", id),
          title: `Using ${toolName}`,
          status: "error",
          output: truncateForSlackTask(formatToolOutput(event.error)),
        };
        toolNamesById.delete(id);
        break;
      }

      case "error": {
        const errorText = (event.error ?? "Unknown error") as string;
        yield {
          type: "markdown_text",
          text: `Error: ${errorText}`,
        };
        break;
      }

      default:
        break;
    }
  }
}

function taskId(prefix: string, value: unknown): string {
  return `${prefix}:${stringValue(value) ?? "default"}`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function formatToolOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateForSlackTask(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 1200 ? normalized : `${normalized.slice(0, 1197)}...`;
}

function isStreamChunk(value: unknown): value is StreamChunk {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "markdown_text":
      return typeof record.text === "string";
    case "task_update":
      return typeof record.id === "string" && typeof record.title === "string" && typeof record.status === "string";
    case "plan_update":
      return typeof record.title === "string";
    default:
      return false;
  }
}
