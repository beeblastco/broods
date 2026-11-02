import type { SystemModelMessage, UserContent, UserModelMessage } from "ai";
import type { Attachment, StreamOptions } from "chat";
import { z } from "zod";
import { guardedFetch } from "../harness/isolate/runner/pinned-fetch.mjs";
import type { ChannelReplyIn } from "./domain/channel-record.ts";
import { isContextLengthError } from "./errors.ts";
import { logWarn, redactSensitiveText } from "./log.ts";
import { MAX_ATTACHMENT_BYTES } from "./media-types.ts";
import { getObservabilityContext } from "./otel.ts";

export const CHANNEL_REACH_WILDCARD = "*";

const RETRY_REPLY = "Retry";

// At most 53 bytes, under Telegram's 64-byte callback_data cap.
const QUESTION_BUTTON_PATTERN = /^q:(async_tool_[0-9a-f-]{36}):(\d+):(\d+)$/;

// First match wins, so an error that already says when to retry stays ahead of the rest.
const ERROR_HINTS: [RegExp, string | null][] = [
  [/\b(try|retry) (again )?(in \d|later)/i, null],
  [
    /usage limit|quota|insufficient (balance|.*credit)|credit balance|purchase credits|upgrade your (token )?plan/i,
    "Add credits or upgrade the plan with the model provider.",
  ],
  [
    /rate.?limit|\b429\b|too many requests|overloaded|queue is full/i,
    "Try again in a moment.",
  ],
  [/\btimed? ?out\b|\betimedout\b|\beconnreset\b/i, "Try again."],
  [/ran out of time/i, "Send a message to continue where I left off."],
];

const INLINE_COMMAND_CHANNELS = new Set([
  "discord",
  "gchat",
  "instagram",
  "matrix",
  "messenger",
  "slack",
  "teams",
  "telegram",
  "twilio",
  "whatsapp",
  "zalo",
]);

const WEBHOOK_BODY = z.looseObject({});

export type ChannelIngressEvent =
  | UserModelMessage
  | (SystemModelMessage & { persist?: false });

export type ChannelFile = Attachment & { type: "file"; url: string };

export type ChannelImage = Attachment & { type: "image"; url: string };

export interface ChannelActions {
  sendText(text: string): Promise<void>;
  sendFiles?(files: ChannelFile[], caption?: string): Promise<void>;
  sendImages?(images: ChannelImage[], caption?: string): Promise<void>;
  sendQuestions?(prompt: ChannelQuestionPrompt): Promise<void>;
  // A tap arrives as if the person had sent that reply.
  sendReplyButtons?(text: string, replies: string[]): Promise<void>;
  sendSticker?(sticker: string): Promise<void>;
  sendTyping(): Promise<void>;
  supportsReactions?: boolean;
  reactToMessage(emoji?: string): Promise<void>;
  stream?(
    textStream: AsyncIterable<unknown>,
    options?: StreamOptions,
  ): Promise<string | null>;
}

export interface ChannelQuestion {
  id: string;
  header: string;
  question: string;
  options: ChannelQuestionOption[];
}

export interface ChannelQuestionAnswer {
  statusId: string;
  questionIndex: number;
  optionIndex: number;
}

export interface ChannelQuestionOption {
  label: string;
  description?: string;
}

export interface ChannelQuestionPrompt {
  statusId: string;
  questions: ChannelQuestion[];
  text: string;
}

export interface ChannelRequest {
  method: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string>;
  body: string;
}

export interface ChannelResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
}

// What policy may read; reply-routing secrets (interaction tokens) stay in the opaque `source`.
export interface ChannelIdentity {
  workspaceRef?: string;
  channelId?: string;
  threadId?: string;
  userId?: string;
  userName?: string;
  userRoles?: string[];
}

export interface InboundMessage {
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  // Named, not read: `ingestChannelAttachments` calls each `fetchData` before admission,
  // inside the ACK budget, so a queued turn still carries its media.
  attachments?: Attachment[];
  events?: ChannelIngressEvent[];
  identity?: ChannelIdentity;
  source: Record<string, unknown>;
  // An ask_questions button click; `content` then carries the chosen label.
  answer?: ChannelQuestionAnswer;
}

export interface ParsedChannelMessage {
  kind: "message";
  message: InboundMessage;
  ack?: ChannelResponse;
  // A full run queue answers 503 + Retry-After only when the sender redelivers on a 5xx;
  // otherwise a 5xx would lose the message, so the busy reply is acked.
  redelivers?: true;
}

export interface ParsedChannelContext {
  kind: "context";
  message: InboundMessage;
  ack?: ChannelResponse;
}

export interface ParsedChannelBatch {
  kind: "batch";
  results: Array<ParsedChannelMessage | ParsedChannelContext>;
  ack?: ChannelResponse;
}

export interface ParsedChannelCleanup {
  kind: "cleanup";
  channelName: string;
  conversationKey: string;
  eventId?: string;
  ack?: ChannelResponse;
}

export type ChannelParseResult =
  | ParsedChannelMessage
  | ParsedChannelContext
  | ParsedChannelBatch
  | ParsedChannelCleanup
  | { kind: "ignore"; reason?: string; response?: ChannelResponse }
  | { kind: "response"; reason?: string; response: ChannelResponse };

export type ChannelWebhookBody<T> =
  | { kind: "payload"; payload: T }
  | { kind: "ignore"; reason: "invalid_payload" };

export interface ChannelAdapter {
  readonly name: string;
  // Every agent that verifies a delivery keeps the entries it owns (a WhatsApp number, a Page).
  // Unset, the lowest verifying agentId takes the whole delivery.
  readonly routesEachEntry?: true;
  canHandle(req: ChannelRequest): boolean;
  authenticate(req: ChannelRequest): boolean | Promise<boolean>;
  parse(req: ChannelRequest): ChannelParseResult | Promise<ChannelParseResult>;
  actions(msg: InboundMessage): ChannelActions;
  applyReplyIn?(
    source: Record<string, unknown>,
    replyIn: ChannelReplyIn,
  ): Record<string, unknown>;
  // Rebuilds the reader from `fetchMetadata` for a later turn; absent, the URL is re-read.
  rehydrateAttachment?(attachment: Attachment): Attachment;
}

export async function readFetchedBytes(
  fetchData: () => Promise<Buffer | ArrayBuffer>,
): Promise<Buffer> {
  const bytes = await fetchData();

  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}

// The model picks the URL, so it gets the same pinned guard as an inbound attachment.
export async function channelAttachmentBytes(
  attachment: ChannelFile | ChannelImage,
): Promise<Buffer> {
  if (attachment.fetchData) {
    return await readFetchedBytes(attachment.fetchData);
  }
  const response = await guardedFetch(attachment.url, undefined, {
    binary: true,
    bodyLimitBytes: MAX_ATTACHMENT_BYTES,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Could not read ${attachment.name ?? attachment.url} to upload it (${response.status})`,
    );
  }

  return Buffer.from(
    response.bodyBytes.buffer,
    response.bodyBytes.byteOffset,
    response.bodyBytes.byteLength,
  );
}

// Providers pick a preview from the name, so a nameless upload still needs an extension.
export function channelAttachmentName(
  attachment: ChannelFile | ChannelImage,
): string {
  if (attachment.name) {
    return attachment.name;
  }
  const fromUrl = attachment.url.split("?")[0]?.split("/").pop();

  return fromUrl && fromUrl.includes(".")
    ? fromUrl
    : `file${attachment.type === "image" ? ".png" : ""}`;
}

export function chunkChannelText(text: string, limit: number): string[] {
  if (text.length === 0) {
    return [""];
  }

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + limit, text.length);
    const previousCodeUnit = text.charCodeAt(end - 1);
    const nextCodeUnit = text.charCodeAt(end);
    if (
      end < text.length &&
      previousCodeUnit >= 0xd800 &&
      previousCodeUnit <= 0xdbff &&
      nextCodeUnit >= 0xdc00 &&
      nextCodeUnit <= 0xdfff
    ) {
      // Never split a pair; when it alone is wider than the limit, keep it whole.
      end = end - 1 > offset ? end - 1 : end + 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }

  return chunks;
}

export function extractText(content: UserContent): string {
  if (typeof content === "string") return content;

  return content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("");
}

export function formatChannelErrorText(
  error: string,
  channelName?: string,
): string {
  return `⚠️ ${simplifyErrorText(error, supportsInlineCommands(channelName))}`;
}

export async function sendChannelFailure(
  channel: ChannelActions,
  text: string,
): Promise<void> {
  if (channel.sendReplyButtons) {
    await channel.sendReplyButtons(text, [RETRY_REPLY]);
    return;
  }
  await channel.sendText(
    `${text}\nReply "${RETRY_REPLY.toLowerCase()}" to try again.`,
  );
}

export function isAllowedId(
  allowed: ReadonlySet<string> | null | undefined,
  id: string | undefined,
): boolean {
  if (!allowed || allowed.has(CHANNEL_REACH_WILDCARD)) return true;
  if (!id) return false;

  return allowed.has(id);
}

export function parseChannelWebhookBody<T extends object>(
  channel: string,
  body: string,
): ChannelWebhookBody<T> {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    logWarn("Channel webhook body rejected", {
      channel: channel,
      reason: "malformed_json",
    });

    return { kind: "ignore", reason: "invalid_payload" };
  }
  const result = WEBHOOK_BODY.safeParse(json);
  if (!result.success) {
    logWarn("Channel webhook body rejected", {
      channel: channel,
      reason: result.error.issues[0]?.message ?? "not_an_object",
    });

    return { kind: "ignore", reason: "invalid_payload" };
  }

  return { kind: "payload", payload: result.data as T };
}

export function parseQuestionButtonId(
  id: string | undefined,
): ChannelQuestionAnswer | undefined {
  const match = QUESTION_BUTTON_PATTERN.exec(id ?? "");
  if (!match) return undefined;

  return {
    statusId: match[1]!,
    questionIndex: Number(match[2]),
    optionIndex: Number(match[3]),
  };
}

export function questionButtonId(
  statusId: string,
  questionIndex: number,
  optionIndex: number,
): string {
  return `q:${statusId}:${questionIndex}:${optionIndex}`;
}

// No list stays null, which the reach gate reads as open; an empty Set blocks everyone.
export function reachSet(ids: string[] | undefined): Set<string> | null {
  return ids ? new Set(ids) : null;
}

export function supportsInlineCommands(
  channelName: string | undefined,
): boolean {
  return channelName !== undefined && INLINE_COMMAND_CHANNELS.has(channelName);
}

function simplifyErrorText(raw: string, commands: boolean): string {
  const text = redactSensitiveText(
    raw,
    getObservabilityContext()?.secretValues,
  );
  const message = (text.match(/Last error:\s*(.+)$/is)?.[1] ?? text)
    .replace(/^AI_\w+:\s*/, "")
    .replace(/ in organization org-[\w-]+/, "")
    .replace(/ ?Visit https?:\/\/\S+ to learn more\./g, "")
    .trim();
  if (!message) {
    return "Something went wrong while generating a reply. Try again.";
  }
  const hint = isContextLengthError(message)
    ? commands
      ? "Send /compact to summarize the conversation, or /new to start over if that fails."
      : "Start a new conversation to continue."
    : ERROR_HINTS.find(([pattern]) => pattern.test(message))?.[1];

  return hint ? `${message.replace(/[.!?]$/, "")}. ${hint}` : message;
}
