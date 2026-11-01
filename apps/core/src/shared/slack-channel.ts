import {
  cardToBlockKit,
  cardToFallbackText,
  SlackAdapter,
  SlackFormatConverter,
  type SlackEvent,
} from "@chat-adapter/slack";
import {
  assertSlackOk,
  callSlackApi,
  postSlackMessage,
  sendSlackResponseUrl,
  SlackApiError,
  uploadSlackFiles,
  type SlackApiOptions,
  type SlackFileUpload,
} from "@chat-adapter/slack/api";
import { answeredSlackInputBlocks } from "@chat-adapter/slack/blocks";
import {
  parseSlackWebhookBody,
  verifySlackSignature,
  type SlackBlockActionsPayload,
  type SlackSlashCommandPayload,
} from "@chat-adapter/slack/webhook";
import {
  Actions,
  Button,
  Card,
  CardText,
  ConsoleLogger,
  Image,
  type Attachment,
  type CardElement,
  type ImageElement,
  type StreamChunk,
} from "chat";
import {
  channelAttachmentBytes,
  channelAttachmentName,
  isAllowedId,
  parseChannelWebhookBody,
  parseQuestionButtonId,
  questionButtonId,
  type ChannelActions,
  type ChannelAdapter,
  type ChannelParseResult,
} from "./channels.ts";
import { parseCommand } from "./commands.ts";
import { channelApiFetch } from "./http.ts";
import { logWarn } from "./log.ts";
import {
  SLACK_COMMAND_INTEGRATION_PREFIX,
  SLACK_INTEGRATION_PREFIX,
} from "./runtime-keys.ts";

// Each flush blocks the model stream on one Slack API round trip (~200ms).
const REASONING_FLUSH_INTERVAL_MS = 500;

const SLACK_TASK_TEXT_LIMIT = 1200;

const SLACK_FILE_SHARE_SUBTYPE = "file_share";

// File URLs come from the webhook body; only Slack hosts may be handed the bot token.
const SLACK_FILE_HOST_SUFFIXES = [
  ".slack.com",
  ".slack-edge.com",
  ".slack-files.com",
];

// Slack rejects a whole message whose button text runs past this.
const SLACK_BUTTON_TEXT_LIMIT = 75;

const SLACK_NO_THREAD = "channel";

const SLACK_FILE_MAX_REDIRECTS = 5;

const SLACK_FILE_TIMEOUT_MS = 30_000;

type SlackUserNameResolver = (userId: string) => Promise<string | null>;

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
  /** Where the reply goes; unset posts to the channel. */
  threadTs?: string;
  /** The thread the message arrived in. */
  inThreadTs?: string;
  messageTs?: string;
  responseUrl?: string;
  commandToken?: string;
  userId?: string;
}

// The reply is sent once at the end, below the progress card, from the final step only: some
// models repeat it in tool steps. appendStream appends `details`, so reasoning goes as deltas.
export async function* toSlackStream(
  textStream: AsyncIterable<unknown>,
): AsyncGenerator<string | StreamChunk> {
  let stepText = "";
  let finalText = "";
  let lastInterimText = "";
  let stepHadToolCalls = false;
  let reasoningChars = 0;
  let reasoningSegment = 0;
  let pendingReasoning = "";
  let pendingReasoningId: unknown;
  let lastReasoningFlushAt = 0;
  const reasoningTaskIds = new Map<string, string>();
  const toolNamesById = new Map<string, string>();

  const flushReasoning = (): StreamChunk | null => {
    if (!pendingReasoning || reasoningChars >= SLACK_TASK_TEXT_LIMIT) {
      pendingReasoning = "";

      return null;
    }
    const remaining = SLACK_TASK_TEXT_LIMIT - reasoningChars;
    const details =
      pendingReasoning.length <= remaining
        ? pendingReasoning
        : remaining > 3
          ? `${pendingReasoning.slice(0, remaining - 3)}...`
          : pendingReasoning.slice(0, remaining);
    reasoningChars += details.length;
    pendingReasoning = "";
    lastReasoningFlushAt = Date.now();

    return {
      type: "task_update",
      id: reasoningTaskId(pendingReasoningId, false),
      title: "Thinking",
      status: "in_progress",
      details: details,
    };
  };

  // Adapters reuse one reasoning id every step; a per-segment id keeps each thinking burst in
  // execution order with the tool tasks instead of merged into the first.
  const reasoningTaskId = (rawId: unknown, fresh: boolean): string => {
    const key = stringValue(rawId) ?? "default";
    let id = fresh ? undefined : reasoningTaskIds.get(key);
    if (!id) {
      reasoningSegment += 1;
      id = taskId("reasoning", `${key}#${reasoningSegment}`);
      reasoningTaskIds.set(key, id);
    }

    return id;
  };

  for await (const chunk of textStream) {
    if (typeof chunk === "string") {
      stepText += chunk;
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
          stepText += text;
        }
        break;
      }

      case "finish-step": {
        const pending = flushReasoning();
        if (pending) yield pending;
        // UI-stream chunks carry no finishReason; the step's tool events stand in.
        const finishReason = stringValue(event.finishReason);
        const interim = finishReason
          ? finishReason === "tool-calls"
          : stepHadToolCalls;
        const trimmedStepText = stepText.trim();
        if (interim) {
          if (trimmedStepText) {
            lastInterimText = stepText;
          }
        } else if (trimmedStepText) {
          finalText = appendBufferedSlackText(finalText, stepText, true);
        }
        stepText = "";
        stepHadToolCalls = false;
        break;
      }

      case "reasoning-start": {
        reasoningChars = 0;
        pendingReasoning = "";
        pendingReasoningId = event.id;
        lastReasoningFlushAt = Date.now();
        yield {
          type: "task_update",
          id: reasoningTaskId(event.id, true),
          title: "Thinking",
          status: "in_progress",
        };
        break;
      }

      case "reasoning-delta": {
        const text = (event.text ?? event.delta ?? "") as string;
        if (text && reasoningChars < SLACK_TASK_TEXT_LIMIT) {
          pendingReasoning += text;
          pendingReasoningId = event.id;
          if (
            Date.now() - lastReasoningFlushAt >=
            REASONING_FLUSH_INTERVAL_MS
          ) {
            const update = flushReasoning();
            if (update) yield update;
          }
        }
        break;
      }

      case "reasoning-end": {
        const update = flushReasoning();
        if (update) yield update;
        // No `output`: it would re-append the reasoning the details already carry.
        yield {
          type: "task_update",
          id: reasoningTaskId(event.id, false),
          title: "Thinking",
          status: "complete",
        };
        reasoningTaskIds.delete(stringValue(event.id) ?? "default");
        reasoningChars = 0;
        break;
      }

      case "tool-input-start": {
        const pending = flushReasoning();
        if (pending) yield pending;
        stepHadToolCalls = true;
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
        break;
      }

      case "tool-call": {
        const pending = flushReasoning();
        if (pending) yield pending;
        stepHadToolCalls = true;
        const toolName = (event.toolName ?? "tool") as string;
        const id =
          stringValue(event.toolCallId) ?? stringValue(event.id) ?? toolName;
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
        const id =
          stringValue(event.toolCallId) ?? stringValue(event.id) ?? "tool";
        const toolName = (event.toolName ??
          toolNamesById.get(id) ??
          "tool") as string;
        yield {
          type: "task_update",
          id: taskId("tool", id),
          title: `Using ${toolName}`,
          status: "complete",
          output: truncateText(
            formatToolOutput(event.output),
            SLACK_TASK_TEXT_LIMIT,
          ),
        };
        toolNamesById.delete(id);
        break;
      }

      case "tool-error": {
        const id =
          stringValue(event.toolCallId) ?? stringValue(event.id) ?? "tool";
        const toolName = (event.toolName ??
          toolNamesById.get(id) ??
          "tool") as string;
        yield {
          type: "task_update",
          id: taskId("tool", id),
          title: `Using ${toolName}`,
          status: "error",
          output: truncateText(
            formatToolOutput(event.error),
            SLACK_TASK_TEXT_LIMIT,
          ),
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

  // Covers a stream with no closing finish-step. With no final text, fall back to the last
  // interim step so a model that answered only beside a tool call still replies.
  const trailingText = stepText.trim()
    ? appendBufferedSlackText(finalText, stepText, true)
    : finalText;
  const text = trailingText.trim() ? trailingText : lastInterimText;
  if (text) {
    yield text;
  }
}

export function createSlackChannel(
  botToken: string,
  signingSecret: string,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
  reactionEmoji = "eyes",
  apiUrl?: string,
  userNameResolver?: SlackUserNameResolver,
): ChannelAdapter {
  const slack = new SlackAdapter({
    apiUrl: apiUrl,
    botToken: botToken,
    signingSecret: signingSecret,
    mode: "webhook",
    logger: new ConsoleLogger("error").child("slack"),
  });

  return {
    name: "slack",

    rehydrateAttachment: function (attachment) {
      return slack.rehydrateAttachment(attachment);
    },

    canHandle: function (req) {
      return "x-slack-signature" in req.headers;
    },

    authenticate: async function (req) {
      try {
        await verifySlackSignature(req.body, req.headers, {
          signingSecret: signingSecret,
        });

        return true;
      } catch (err) {
        logWarn("Slack request signature verification failed", {
          error: err instanceof Error ? err.message : String(err),
        });

        return false;
      }
    },

    parse: function (req): ChannelParseResult | Promise<ChannelParseResult> {
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
        return parseSlashCommand(payload, allowedChannelIds, allowedUserIds);
      }

      if (payload.kind === "block_actions") {
        return parseQuestionClick(payload, allowedChannelIds, allowedUserIds);
      }

      if (
        (req.headers["content-type"] ?? "").includes(
          "application/x-www-form-urlencoded",
        )
      ) {
        return {
          kind: "ignore",
          reason: `unsupported_slack_payload:${payload.kind}`,
        };
      }

      return parseEventCallback(
        req.body,
        botToken,
        allowedChannelIds,
        allowedUserIds,
        userNameResolver ?? createSlackUserNameResolver(slack),
      );
    },

    actions: function (msg): ChannelActions {
      return createSlackActions(
        botToken,
        apiUrl,
        slack,
        toSlackSource(msg.source),
        reactionEmoji,
      );
    },

    applyReplyIn: function (source, replyIn) {
      const slackSource = toSlackSource(source);
      const threadTs =
        replyIn === "thread"
          ? (slackSource.inThreadTs ?? slackSource.messageTs)
          : slackSource.inThreadTs;

      return { ...source, threadTs: threadTs };
    },
  };
}

async function formatSlackMessageText(
  text: string,
  userId: string | undefined,
  isGroupChannel: boolean,
  omittedUserIds: Set<string>,
  resolveUserName: SlackUserNameResolver,
): Promise<string> {
  const normalized = await normalizeSlackMentions(
    text,
    omittedUserIds,
    resolveUserName,
  );
  if (!isGroupChannel || !userId || !normalized || parseCommand(normalized)) {
    return normalized;
  }

  return `${await resolveSlackUserName(userId, resolveUserName)}: ${normalized}`;
}

async function normalizeSlackMentions(
  text: string,
  omittedUserIds: Set<string>,
  resolveUserName: SlackUserNameResolver,
): Promise<string> {
  const mentionedUserIds = [
    ...new Set(
      [...text.matchAll(/<@([^>]+)>/g)]
        .map((match) => match[1])
        .filter(
          (userId): userId is string =>
            typeof userId === "string" && userId.length > 0,
        ),
    ),
  ];
  const names = new Map<string, string>();

  await Promise.all(
    mentionedUserIds.map(async (userId) => {
      if (omittedUserIds.has(userId)) return;
      names.set(userId, await resolveSlackUserName(userId, resolveUserName));
    }),
  );

  return cleanSlackText(
    text.replace(/<@([^>]+)>/g, (_match, userId: string) => {
      if (omittedUserIds.has(userId)) return "";

      return `@${names.get(userId) ?? userId}`;
    }),
  );
}

async function parseEventCallback(
  body: string,
  botToken: string,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
  resolveUserName: SlackUserNameResolver,
): Promise<ChannelParseResult> {
  const parsed = parseChannelWebhookBody<SlackEventEnvelope>("slack", body);
  if (parsed.kind === "ignore") {
    return parsed;
  }
  const payload = parsed.payload;

  if (
    payload.type === "url_verification" &&
    typeof payload.challenge === "string"
  ) {
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

  if (
    payload.type !== "event_callback" ||
    !isSlackMessageEvent(payload.event) ||
    !payload.event_id ||
    !payload.team_id
  ) {
    return { kind: "ignore", reason: "invalid_event_callback" };
  }

  if (!isSupportedSlackEvent(payload.event)) {
    return {
      kind: "ignore",
      reason: getUnsupportedSlackEventReason(payload.event),
    };
  }

  const channelId = payload.event.channel;
  const ts = payload.event.ts;
  if (!channelId || !ts) {
    return { kind: "ignore", reason: "missing_channel_or_timestamp" };
  }

  if (!isAllowedId(allowedChannelIds, channelId)) {
    logWarn("Slack channel not in allow list", { channelId: channelId });

    return { kind: "ignore", reason: "channel_not_allowed" };
  }

  const eventUser = payload.event.user;
  if (!isAllowedId(allowedUserIds, eventUser)) {
    logWarn("Slack sender not in allow list", { userId: eventUser });

    return { kind: "ignore", reason: "user_not_allowed" };
  }

  if (
    payload.event.type === "message" &&
    mentionsSlackBot(payload.event.text ?? "", payload)
  ) {
    return {
      kind: "ignore",
      reason: "message_with_mention_wait_for_app_mention",
    };
  }

  const isGroupChannel =
    payload.event.channel_type !== "im" &&
    payload.event.channel_type !== "app_home";
  const runAgent =
    payload.event.type === "app_mention" ||
    payload.event.channel_type === "im" ||
    payload.event.channel_type === "app_home";
  const botUserIds = runAgent ? getSlackBotUserIds(payload) : new Set<string>();
  const rawText =
    payload.event.type === "app_mention" && botUserIds.size === 0
      ? (payload.event.text ?? "").replace(/<@[^>]+>\s*/, "")
      : (payload.event.text ?? "");
  const text = await formatSlackMessageText(
    rawText,
    payload.event.user,
    isGroupChannel,
    botUserIds,
    resolveUserName,
  );
  const threadTs = payload.event.thread_ts ?? ts;
  const replyThreadTs = getSlackReplyThreadTs(payload.event, ts);
  const userName = payload.event.user
    ? await resolveSlackUserName(payload.event.user, resolveUserName)
    : undefined;
  const attachments = slackAttachments(payload.event.files ?? [], botToken);
  const source: SlackSource = {
    teamId: payload.team_id,
    channelId: channelId,
    messageTs: ts,
    threadTs: replyThreadTs,
    inThreadTs: payload.event.thread_ts,
    userId: payload.event.user,
  };

  return {
    kind: runAgent ? "message" : "context",
    redelivers: true,
    ack: { statusCode: 200 },
    message: {
      // app_mention and message both arrive for one mention; the ts key dedupes them at claim.
      eventId: `${SLACK_INTEGRATION_PREFIX}${payload.team_id}:${channelId}:${ts}`,
      conversationKey: getSlackConversationKey(
        payload.team_id,
        channelId,
        payload.event,
        threadTs,
      ),
      channelName: "slack",
      content: [{ type: "text", text: text }],
      ...(attachments.length > 0 ? { attachments: attachments } : {}),
      identity: {
        workspaceRef: payload.team_id,
        channelId: channelId,
        ...(payload.event.thread_ts
          ? { threadId: payload.event.thread_ts }
          : {}),
        ...(payload.event.user ? { userId: payload.event.user } : {}),
        ...(userName ? { userName: userName } : {}),
      },
      source: { ...source },
    },
  };
}

async function resolveSlackUserName(
  userId: string,
  resolveUserName: SlackUserNameResolver,
): Promise<string> {
  const resolved = await resolveUserName(userId);

  return cleanSlackName(resolved) || userId;
}

async function sendSlackWebhookResponse(
  url: string,
  text: string,
  blocks?: unknown[],
): Promise<void> {
  try {
    await sendSlackResponseUrl(url, {
      text: text,
      ...(blocks ? { blocks: blocks } : {}),
      responseType: "in_channel",
    });
  } catch (err) {
    if (err instanceof SlackApiError) {
      throw new Error(`Slack response_url failed (${err.status ?? 0})`);
    }
    throw err;
  }
}

function appendBufferedSlackText(
  current: string,
  text: string,
  needsSeparator: boolean,
): string {
  if (!text) return current;
  if (needsSeparator && current) {
    return `${current}\n\n${text}`;
  }

  return `${current}${text}`;
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

function createSlackActions(
  botToken: string,
  apiUrl: string | undefined,
  slack: SlackAdapter,
  source: SlackSource,
  reactionEmoji: string,
): ChannelActions {
  const api: SlackApiOptions = {
    token: botToken,
    apiUrl: apiUrl,
    fetch: channelApiFetch(apiUrl),
  };
  const threadId = source.threadTs
    ? slack.encodeThreadId({
        channel: source.channelId,
        threadTs: source.threadTs,
      })
    : undefined;
  const formatter = new SlackFormatConverter();

  return {
    sendFiles: async function (files, caption): Promise<void> {
      // Slack ignores URL attachments; one files.uploadV2 call lands the batch as one upload.
      await uploadSlackFiles(
        await Promise.all(
          files.map(async (file): Promise<SlackFileUpload> => {
            const name = channelAttachmentName(file);

            return {
              data: await channelAttachmentBytes(file),
              filename: name,
              title: name,
            };
          }),
        ),
        {
          ...api,
          channelId: source.channelId,
          ...(caption ? { initialComment: caption } : {}),
          ...(source.threadTs ? { threadTs: source.threadTs } : {}),
        },
      );
    },

    sendImages: async function (images, caption): Promise<void> {
      // Image blocks, not an upload: a block renders inline, an uploaded file is an attachment.
      await postSlackCard(
        api,
        source,
        Card({
          children: [
            ...(caption ? [CardText(caption)] : []),
            ...images.map((image): ImageElement =>
              Image({
                url: image.url,
                alt: image.name ?? caption ?? "Image",
              }),
            ),
          ],
        }),
      );
    },

    // Each button carries the thread, so a click anywhere resolves to the same conversation.
    sendQuestions: async function (prompt): Promise<void> {
      const single = prompt.questions.length === 1;
      const thread = source.inThreadTs ?? source.messageTs ?? SLACK_NO_THREAD;
      await postSlackCard(
        api,
        source,
        Card({
          children: [
            CardText(prompt.text),
            ...prompt.questions.map((question, questionIndex) =>
              Actions(
                question.options.map((option, optionIndex) =>
                  Button({
                    id: questionButtonId(
                      prompt.statusId,
                      questionIndex,
                      optionIndex,
                    ),
                    label: truncateText(
                      single
                        ? option.label
                        : `${question.header}: ${option.label}`,
                      SLACK_BUTTON_TEXT_LIMIT,
                    ),
                    value: thread,
                  }),
                ),
              ),
            ),
          ],
        }),
      );
    },

    sendSticker: async function (sticker): Promise<void> {
      const value = sticker.trim();
      if (!value) {
        throw new Error(
          "Slack sendSticker needs a custom emoji name or public http(s) image URL",
        );
      }
      if (value.includes("://")) {
        await postSlackCard(
          api,
          source,
          Card({
            children: [Image({ url: value, alt: "Sticker" })],
          }),
        );

        return;
      }
      const emojiName = value.replace(/^:+|:+$/g, "");
      const text = /^[a-z0-9_+-]+$/i.test(emojiName) ? `:${emojiName}:` : value;
      if (source.responseUrl) {
        await sendSlackWebhookResponse(source.responseUrl, text);

        return;
      }
      await postSlackMessage({
        ...api,
        channel: source.channelId,
        text: text,
        threadTs: source.threadTs,
      });
    },

    sendText: async function (text) {
      if (source.responseUrl) {
        await sendSlackWebhookResponse(
          source.responseUrl,
          formatter.toResponseUrlText({ markdown: text }),
        );

        return;
      }

      await postSlackMessage({
        ...api,
        channel: source.channelId,
        markdownText: text,
        threadTs: source.threadTs,
        unfurlLinks: false,
        unfurlMedia: false,
      });
    },

    sendTyping: async function () {
      return;
    },

    supportsReactions: Boolean(source.messageTs),
    reactToMessage: async function (emoji): Promise<void> {
      if (!source.messageTs) {
        return;
      }

      assertSlackOk(
        "reactions.add",
        await callSlackApi(
          "reactions.add",
          {
            channel: source.channelId,
            timestamp: source.messageTs,
            name: (emoji ?? reactionEmoji).replace(/^:+|:+$/g, ""),
          },
          {
            ...api,
            contentType: "json",
          },
        ),
      );
    },

    ...(threadId && source.userId
      ? {
          stream: async (textStream, options) => {
            const result = await slack.stream(
              threadId,
              toSlackStream(textStream),
              {
                ...options,
                recipientTeamId: source.teamId,
                recipientUserId: source.userId!,
                taskDisplayMode: "plan",
              },
            );

            return result?.id ?? null;
          },
        }
      : {}),
  };
}

async function postSlackCard(
  api: SlackApiOptions,
  source: SlackSource,
  card: CardElement,
): Promise<void> {
  const text = cardToFallbackText(card) || "Image";
  const blocks = cardToBlockKit(card);
  if (source.responseUrl) {
    await sendSlackWebhookResponse(source.responseUrl, text, blocks);

    return;
  }
  await postSlackMessage({
    ...api,
    channel: source.channelId,
    text: text,
    blocks: blocks,
    threadTs: source.threadTs,
    unfurlLinks: false,
    unfurlMedia: false,
  });
}

function createSlackUserNameResolver(
  slack: SlackAdapter,
): SlackUserNameResolver {
  return async (userId) => {
    const user = await slack.getUser(userId);

    return user?.userName ?? user?.fullName ?? null;
  };
}

function formatToolOutput(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable tool output]";
  }
}

function getSlackBotUserIds(payload: SlackEventEnvelope): Set<string> {
  return new Set(
    (payload.authorizations ?? [])
      .filter((authorization) => authorization.is_bot !== false)
      .map((authorization) => authorization.user_id)
      .filter(
        (userId): userId is string =>
          typeof userId === "string" && userId.length > 0,
      ),
  );
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
    (event.type === "message" &&
      event.channel_type !== "im" &&
      event.channel_type !== "app_home")
  ) {
    return event.thread_ts ?? messageTs;
  }

  return event.thread_ts;
}

// url_private needs the bot token. The Chat SDK adds that reader only on its handleWebhook
// path, which this adapter skips to gate on channel, sender and mention first.
function slackAttachments(
  files: NonNullable<SlackEvent["files"]>,
  botToken: string,
): Attachment[] {
  return files.flatMap((file): Attachment[] => {
    const url = file.url_private;
    if (!url) {
      return [];
    }
    const mimeType = slackFileMediaType(file);

    return [
      {
        type: slackAttachmentType(mimeType),
        url: url,
        ...(file.name ? { name: file.name } : {}),
        ...(mimeType ? { mimeType: mimeType } : {}),
        ...(file.size !== undefined ? { size: file.size } : {}),
        ...(file.original_w !== undefined ? { width: file.original_w } : {}),
        ...(file.original_h !== undefined ? { height: file.original_h } : {}),
        fetchData: (): Promise<Buffer> => fetchSlackFile(url, botToken),
      },
    ];
  });
}

function slackAttachmentType(mimeType: string | undefined): Attachment["type"] {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";

  return "file";
}

// Slack serves a voice clip as video/*, which providers refuse though they could hear it.
function slackFileMediaType(
  file: NonNullable<SlackEvent["files"]>[number],
): string | undefined {
  const mimeType = file.mimetype;
  const subtype = (file as { subtype?: string }).subtype;

  return subtype === "slack_audio" && mimeType?.startsWith("video/")
    ? mimeType.replace("video/", "audio/")
    : mimeType;
}

// Redirects are followed by hand so each hop's host is checked before the token goes out.
// Slack answers a bad token with a 200 HTML login page, so content type is the failure signal.
async function fetchSlackFile(url: string, botToken: string): Promise<Buffer> {
  let target = assertSlackFileUrl(url);
  for (let hop = 0; hop < SLACK_FILE_MAX_REDIRECTS; hop++) {
    const response = await fetch(target, {
      headers: { authorization: `Bearer ${botToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(SLACK_FILE_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (location && response.status >= 300 && response.status < 400) {
      target = assertSlackFileUrl(new URL(location, target).toString());
      continue;
    }
    if (!response.ok) {
      throw new Error(`Slack answered ${response.status}`);
    }
    if ((response.headers.get("content-type") ?? "").includes("text/html")) {
      throw new Error(
        "Slack returned its login page instead of the file. The app needs the files:read scope",
      );
    }

    return Buffer.from(await response.arrayBuffer());
  }

  throw new Error("Slack file download redirected too many times");
}

function assertSlackFileUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`refusing to send the Slack token over ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (
    host !== "slack.com" &&
    !SLACK_FILE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    throw new Error(`refusing to send the Slack token to ${host}`);
  }

  return url;
}

function getUnsupportedSlackEventReason(event: SlackEvent): string {
  if (event.bot_id) return "bot_message";
  if (event.subtype) return `unsupported_subtype:${event.subtype}`;
  if (event.type === "message")
    return `unsupported_message_channel:${event.channel_type ?? "unknown"}`;

  return `unsupported_event:${event.type ?? "unknown"}`;
}

function hasSlackMention(text: string): boolean {
  return /<@[^>]+>/.test(text);
}

function isSlackMessageEvent(
  event: SlackEvent | undefined,
): event is SlackEvent {
  return Boolean(event && "type" in event && typeof event.type === "string");
}

function isStreamChunk(value: unknown): value is StreamChunk {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "markdown_text":
      return typeof record.text === "string";
    case "task_update":
      return (
        typeof record.id === "string" &&
        typeof record.title === "string" &&
        typeof record.status === "string"
      );
    case "plan_update":
      return typeof record.title === "string";
    default:
      return false;
  }
}

function isSupportedSlackEvent(event: SlackEvent): boolean {
  if (event.bot_id) {
    return false;
  }
  // file_share is a message carrying an upload; every other subtype is an event about one.
  if (event.subtype && event.subtype !== SLACK_FILE_SHARE_SUBTYPE) {
    return false;
  }

  if (event.type === "app_mention") {
    return true;
  }

  return (
    event.type === "message" &&
    isSupportedSlackMessageChannel(event.channel_type)
  );
}

function isSupportedSlackMessageChannel(
  channelType: string | undefined,
): boolean {
  return (
    channelType === "channel" ||
    channelType === "group" ||
    channelType === "mpim" ||
    channelType === "im" ||
    channelType === "app_home"
  );
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

function parseQuestionClick(
  payload: SlackBlockActionsPayload,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
): ChannelParseResult {
  const action = payload.actions[0];
  const answer = parseQuestionButtonId(action?.actionId);
  const { channelId, teamId } = payload;
  if (!action || !answer || !channelId || !teamId) {
    return { kind: "ignore", reason: "unsupported_slack_action" };
  }
  if (
    !isAllowedId(allowedChannelIds, channelId) ||
    !isAllowedId(allowedUserIds, payload.userId)
  ) {
    return { kind: "ignore", reason: "not allowed" };
  }
  if (payload.responseUrl) {
    void sendSlackResponseUrl(payload.responseUrl, {
      replaceOriginal: true,
      text: action.label ?? "Answered",
      blocks: answeredSlackInputBlocks({
        answer: action.label ?? "Answered",
        promptBlock: payload.messagePromptBlock,
        userId: payload.userId,
      }),
    }).catch((err: unknown): void => {
      logWarn("Slack question answer update failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  // A DM (id starts with D) or a slash command is one conversation per channel.
  const thread =
    channelId.startsWith("D") || action.value === SLACK_NO_THREAD
      ? undefined
      : (action.value ?? payload.threadTs);
  const source: SlackSource = {
    teamId: teamId,
    channelId: channelId,
    ...(thread ? { threadTs: thread, inThreadTs: thread } : {}),
    userId: payload.userId,
  };

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}:action:${payload.triggerId ?? payload.messageTs}`,
      conversationKey: thread
        ? `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}:${thread}`
        : `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}`,
      channelName: "slack",
      content: "[button answer]",
      identity: {
        workspaceRef: teamId,
        channelId: channelId,
        ...(thread ? { threadId: thread } : {}),
        userId: payload.userId,
        ...(payload.userName ? { userName: payload.userName } : {}),
      },
      source: { ...source },
      answer: answer,
    },
  };
}

function parseSlashCommand(
  payload: SlackSlashCommandPayload,
  allowedChannelIds: Set<string> | null,
  allowedUserIds: Set<string> | null,
): ChannelParseResult {
  const teamId = payload.teamId;
  const channelId = payload.channelId;
  const command = payload.command;

  if (!teamId || !channelId || !command) {
    return { kind: "ignore", reason: "invalid_slash_command" };
  }

  if (!isAllowedId(allowedChannelIds, channelId)) {
    logWarn("Slack slash command channel not in allow list", {
      channelId: channelId,
    });

    return { kind: "ignore", reason: "slash_command_channel_not_allowed" };
  }

  if (!isAllowedId(allowedUserIds, payload.userId)) {
    logWarn("Slack slash command sender not in allow list", {
      userId: payload.userId,
    });

    return { kind: "ignore", reason: "slash_command_user_not_allowed" };
  }

  const text = payload.text ?? "";
  const source: SlackSource = {
    teamId: teamId,
    channelId: channelId,
    responseUrl: payload.responseUrl,
    commandToken: command,
    userId: payload.userId,
  };

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${SLACK_COMMAND_INTEGRATION_PREFIX}${payload.triggerId ?? `${teamId}:${channelId}:${command}:${text}`}`,
      // Slack sends no thread on a slash command; in a thread, `@bot /new` is an app_mention.
      conversationKey: `${SLACK_INTEGRATION_PREFIX}${teamId}:${channelId}`,
      channelName: "slack",
      content: [{ type: "text", text: text }],
      identity: {
        workspaceRef: teamId,
        channelId: channelId,
        ...(payload.userId ? { userId: payload.userId } : {}),
      },
      source: { ...source },
    },
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function taskId(prefix: string, value: unknown): string {
  return `${prefix}:${stringValue(value) ?? "default"}`;
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
    inThreadTs:
      typeof source.inThreadTs === "string" ? source.inThreadTs : undefined,
    messageTs:
      typeof source.messageTs === "string" ? source.messageTs : undefined,
    responseUrl:
      typeof source.responseUrl === "string" ? source.responseUrl : undefined,
    commandToken:
      typeof source.commandToken === "string" ? source.commandToken : undefined,
    userId: typeof source.userId === "string" ? source.userId : undefined,
  };
}

function truncateText(value: string, limit: number): string {
  const normalized = value.trim();

  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 3)}...`;
}
