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

type SlackUserNameResolver = (userId: string) => Promise<string | null>;

export function createSlackChannel(
  botToken: string,
  signingSecret: string,
  allowedChannelIds: Set<string> | null,
  reactionEmoji = "eyes",
  apiUrl?: string,
  userNameResolver?: SlackUserNameResolver,
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

    parse(req): ChannelParseResult | Promise<ChannelParseResult> {
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

      return parseEventCallback(req.body, allowedChannelIds, userNameResolver ?? createSlackUserNameResolver(slack));
    },

    actions(msg): ChannelActions {
      return createSlackActions(botToken, slack, toSlackSource(msg.source), reactionEmoji);
    },
  };
}

async function parseEventCallback(
  body: string,
  allowedChannelIds: Set<string> | null,
  resolveUserName: SlackUserNameResolver,
): Promise<ChannelParseResult> {
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
  const runAgent = payload.event.type === "app_mention"
    || payload.event.channel_type === "im"
    || payload.event.channel_type === "app_home";
  const botUserIds = runAgent ? getSlackBotUserIds(payload) : new Set<string>();
  const rawText = payload.event.type === "app_mention" && botUserIds.size === 0
    ? (payload.event.text ?? "").replace(/<@[^>]+>\s*/, "")
    : payload.event.text ?? "";
  const text = await formatSlackMessageText(rawText, payload.event.user, isGroupChannel, botUserIds, resolveUserName);
  const threadTs = payload.event.thread_ts ?? ts;
  const replyThreadTs = getSlackReplyThreadTs(payload.event, ts);

  return {
    kind: runAgent ? "message" : "context",
    ack: { statusCode: 200 },
    message: {
      // Use team:channel:ts as the eventId so that duplicate Slack deliveries
      // (app_mention + message for the same mention) dedupe naturally via
      // session.claim().  ts is unique per message within a channel.
      eventId: `${SLACK_INTEGRATION_PREFIX}${payload.team_id}:${channelId}:${ts}`,
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
  if (event.channel_type === "im" || event.channel_type === "app_home") {
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
          const result = await slack.stream(threadId, toSlackStream(textStream), {
            ...options,
            recipientTeamId: source.teamId,
            recipientUserId: source.userId!,
            taskDisplayMode: "plan",
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
 * Convert Slack mrkdwn mention syntax into readable names for the model. Bot
 * mentions that only target the app are removed from the user text.
 */
async function normalizeSlackMentions(
  text: string,
  omittedUserIds: Set<string>,
  resolveUserName: SlackUserNameResolver,
): Promise<string> {
  const mentionedUserIds = [...new Set([...text.matchAll(/<@([^>]+)>/g)]
    .map((match) => match[1])
    .filter((userId): userId is string => typeof userId === "string" && userId.length > 0))];
  const names = new Map<string, string>();

  await Promise.all(mentionedUserIds.map(async (userId) => {
    if (omittedUserIds.has(userId)) return;
    names.set(userId, await resolveSlackUserName(userId, resolveUserName));
  }));

  return cleanSlackText(text.replace(/<@([^>]+)>/g, (_match, userId: string) => {
    if (omittedUserIds.has(userId)) return "";
    return `@${names.get(userId) ?? userId}`;
  }));
}

function hasSlackMention(text: string): boolean {
  return /<@[^>]+>/.test(text);
}

function mentionsSlackBot(text: string, payload: SlackEventEnvelope): boolean {
  const botUserIds = getSlackBotUserIds(payload);
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
async function formatSlackMessageText(
  text: string,
  userId: string | undefined,
  isGroupChannel: boolean,
  omittedUserIds: Set<string>,
  resolveUserName: SlackUserNameResolver,
): Promise<string> {
  const normalized = await normalizeSlackMentions(text, omittedUserIds, resolveUserName);
  if (!isGroupChannel || !userId || !normalized) {
    return normalized;
  }
  return `${await resolveSlackUserName(userId, resolveUserName)}: ${normalized}`;
}

function getSlackBotUserIds(payload: SlackEventEnvelope): Set<string> {
  return new Set(
    (payload.authorizations ?? [])
      .filter((authorization) => authorization.is_bot !== false)
      .map((authorization) => authorization.user_id)
      .filter((userId): userId is string => typeof userId === "string" && userId.length > 0),
  );
}

function createSlackUserNameResolver(slack: SlackAdapter): SlackUserNameResolver {
  return async (userId) => {
    const user = await slack.getUser(userId);
    return user?.userName ?? user?.fullName ?? null;
  };
}

async function resolveSlackUserName(userId: string, resolveUserName: SlackUserNameResolver): Promise<string> {
  const resolved = await resolveUserName(userId);
  return cleanSlackName(resolved) || userId;
}

function cleanSlackName(value: string | null): string {
  return (value ?? "").replace(/^@+/, "").trim();
}

function cleanSlackText(value: string): string {
  return value
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Converts the AI SDK full stream into Slack Chat SDK chunks. Text is buffered
 * and sent once at the end so partial answer text does not jump below the
 * progress card while reasoning and tool chunks are still updating.
 *
 * Slack's chat.appendStream APPENDS every task_update's `details` to the task
 * card — it never replaces. Reasoning must therefore stream as per-chunk
 * deltas: sending the accumulated text re-appends each snapshot and renders
 * "TheThe user isThe user is asking…" (broods#115 follow-up).
 */
export async function* toSlackStream(
  textStream: AsyncIterable<unknown>,
): AsyncGenerator<string | StreamChunk> {
  let needsSeparator = false;
  let bufferedText = "";
  let reasoningChars = 0;
  const toolNamesById = new Map<string, string>();

  for await (const chunk of textStream) {
    if (typeof chunk === "string") {
      bufferedText = appendBufferedSlackText(bufferedText, chunk, needsSeparator);
      needsSeparator = false;
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
          bufferedText = appendBufferedSlackText(bufferedText, text, needsSeparator);
          needsSeparator = false;
        }
        break;
      }

      case "finish-step": {
        needsSeparator = true;
        break;
      }

      case "reasoning-start": {
        reasoningChars = 0;
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
        if (text && reasoningChars < SLACK_TASK_TEXT_LIMIT) {
          const remaining = SLACK_TASK_TEXT_LIMIT - reasoningChars;
          // The ellipsis counts against the budget; with under 4 characters
          // left there is no room for it, so the clip ends the text plain.
          const details = text.length <= remaining
            ? text
            : remaining > 3
              ? `${text.slice(0, remaining - 3)}...`
              : text.slice(0, remaining);
          reasoningChars += details.length;
          yield {
            type: "task_update",
            id: taskId("reasoning", event.id),
            title: "Thinking",
            status: "in_progress",
            details,
          };
        }
        break;
      }

      case "reasoning-end": {
        // No `output` here: the appended details already carry the reasoning,
        // and output would re-append the whole text as one more copy.
        yield {
          type: "task_update",
          id: taskId("reasoning", event.id),
          title: "Thinking",
          status: "complete",
        };
        reasoningChars = 0;
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

  if (bufferedText) {
    yield bufferedText;
  }
}

function appendBufferedSlackText(current: string, text: string, needsSeparator: boolean): string {
  if (!text) return current;
  if (needsSeparator && current) {
    return `${current}\n\n${text}`;
  }
  return `${current}${text}`;
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

// Cap on the text a single task accumulates in the card, whether appended
// delta-by-delta (reasoning details) or set once (tool output).
const SLACK_TASK_TEXT_LIMIT = 1200;

function truncateForSlackTask(value: string): string {
  const normalized = value.trim();
  return normalized.length <= SLACK_TASK_TEXT_LIMIT
    ? normalized
    : `${normalized.slice(0, SLACK_TASK_TEXT_LIMIT - 3)}...`;
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
