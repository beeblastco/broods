/** Shared HTTP and channel adapter contracts for inbound webhook traffic. */

import type { SystemModelMessage, UserContent, UserModelMessage } from "ai";
import type { Attachment, StreamOptions } from "chat";
import { z } from "zod";
import { guardedFetch } from "../harness/isolate/runner/pinned-fetch.mjs";
import type { ChannelReplyIn } from "./domain/channel-record.ts";
import { logWarn } from "./log.ts";
import { MAX_ATTACHMENT_BYTES } from "./media-types.ts";

/** Reach every room or sender, instead of only the listed ids. */
export const CHANNEL_REACH_WILDCARD = "*";

// What a Retry tap or typed reply sends after a failed run.
const RETRY_REPLY = "Retry";

// The id an ask_questions button carries back: statusId, question, option.
// 53 bytes at most, under Telegram's 64-byte callback_data cap.
const QUESTION_BUTTON_PATTERN = /^q:(async_tool_[0-9a-f-]{36}):(\d+):(\d+)$/;

// Any JSON object. Fields stay as the provider sent them, nulls included; each
// adapter reads what it needs through its own payload type.
const WEBHOOK_BODY = z.looseObject({});

export type ChannelIngressEvent =
  | UserModelMessage
  | (SystemModelMessage & { persist?: false });

/**
 * A document or picture handed to a channel for delivery. The Chat SDK's own
 * attachment shape, narrowed: a workspace file has no address of its own, so it
 * always travels as a URL the provider fetches for itself. `type` is fixed per
 * alias because that is the field an adapter maps onto the provider's photo or
 * document endpoint.
 */
export type ChannelFile = Attachment & { type: "file"; url: string };

export type ChannelImage = Attachment & { type: "image"; url: string };

export interface ChannelActions {
  sendText(text: string): Promise<void>;
  // Optional document delivery. Omitted by providers with no document endpoint
  // at all (Zalo bots take photos and stickers and nothing else), which is why
  // `send-files` posts download links as text rather than failing.
  sendFiles?(files: ChannelFile[], caption?: string): Promise<void>;
  // Optional picture delivery, the same shape so one tool core serves both.
  // A batch arrives whole and the provider decides how to spend it: Telegram
  // groups it into one album, Zalo has no album and sends them in sequence.
  sendImages?(images: ChannelImage[], caption?: string): Promise<void>;
  // Optional native rendering for an ask_questions prompt (inline buttons).
  // Providers without one omit it and the numbered `text` goes out as plain
  // text, answered by a reply.
  sendQuestions?(prompt: ChannelQuestionPrompt): Promise<void>;
  // Optional buttons under a message; a tap arrives as the person sending that
  // reply. Providers without them omit it and the reply is spelled out instead.
  sendReplyButtons?(text: string, replies: string[]): Promise<void>;
  // Optional provider-native sticker delivery. Providers decide whether the
  // value is a sticker id, file id, or public URL.
  sendSticker?(sticker: string): Promise<void>;
  sendTyping(): Promise<void>;
  supportsReactions?: boolean;
  // Reactions target the inbound message. Omitting the emoji uses the channel's
  // configured acknowledgement reaction.
  reactToMessage(emoji?: string): Promise<void>;
  // Optional native SDK/platform streaming. Channels omit it when the provider
  // lacks SDK streaming support, in which case the harness sends one final reply.
  stream?(
    textStream: AsyncIterable<unknown>,
    options?: StreamOptions,
  ): Promise<string | null>;
}

/** One question the agent asks through ask_questions, as a channel renders it. */
export interface ChannelQuestion {
  id: string;
  header: string;
  question: string;
  options: ChannelQuestionOption[];
  allowFreeText?: boolean;
}

/** A button click on a posted question, by position. */
export interface ChannelQuestionAnswer {
  statusId: string;
  questionIndex: number;
  optionIndex: number;
}

export interface ChannelQuestionOption {
  label: string;
  description?: string;
}

/**
 * What a channel posts for one ask_questions call. `text` is the numbered
 * fallback every provider can send; a button carries `statusId` back.
 */
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

/**
 * Where a message came from and who sent it, in provider-neutral terms.
 * `source` stays opaque because it carries reply-routing secrets (interaction
 * tokens, response URLs); this is the part policy and channel lookup may read.
 */
export interface ChannelIdentity {
  /** Team, guild, or repository owner the channel belongs to. */
  workspaceRef?: string;
  /** Channel, chat, or repository the message arrived in. */
  channelId?: string;
  /** Thread inside the channel, when the message is threaded. */
  threadId?: string;
  /** Provider id of the person who sent it. */
  userId?: string;
  /** Display name for that person, when the provider gives one cheaply. */
  userName?: string;
  /** Roles that person holds in this channel. Filled from the channel record. */
  userRoles?: string[];
}

export interface InboundMessage {
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  /**
   * Pictures, documents, voice notes and videos that arrived with the message, in
   * the wide Chat SDK attachment shape because inbound is whatever the provider
   * sent. Adapters name the attachment and leave the bytes alone, so parsing
   * stays cheap. `fetchData` is the adapter's own authenticated reader (Telegram
   * resolves a file id through getFile and signs the download with the bot token;
   * Slack sends a bearer header for a private file). `ingestChannelAttachments`
   * calls it after parse and before admission, inside the ACK budget, so a
   * queued turn still carries its media.
   */
  attachments?: Attachment[];
  events?: ChannelIngressEvent[];
  identity?: ChannelIdentity;
  source: Record<string, unknown>;
  // Present when the message is a click on an ask_questions button rather than
  // typed text; `content` then carries the chosen label for the transcript.
  answer?: ChannelQuestionAnswer;
}

export interface ParsedChannelMessage {
  kind: "message";
  message: InboundMessage;
  ack?: ChannelResponse;
}

export interface ParsedChannelContext {
  kind: "context";
  message: InboundMessage;
  ack?: ChannelResponse;
}

// Several turns in one delivery, when a provider batches them into one POST.
// Each runs on its own, in order; `ack` answers the whole delivery.
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

/**
 * What the webhook should do before the agent runs. Some providers need an
 * immediate HTTP response; others can be acknowledged and processed later.
 */
export type ChannelParseResult =
  | ParsedChannelMessage
  | ParsedChannelContext
  | ParsedChannelBatch
  | ParsedChannelCleanup
  | { kind: "ignore"; reason?: string; response?: ChannelResponse }
  | { kind: "response"; reason?: string; response: ChannelResponse };

/** A verified webhook body, or the ignore an adapter returns when it is not a JSON object. */
export type ChannelWebhookBody<T> =
  | { kind: "payload"; payload: T }
  | { kind: "ignore"; reason: "invalid_payload" };

export interface ChannelAdapter {
  readonly name: string;
  /**
   * Set when one provider app can serve several agents and every entry of a
   * delivery names its owner (a WhatsApp number, a Page, an Instagram account). Each agent whose
   * credentials verify the delivery parses it and keeps only its own entries.
   * Unset, the lowest verifying agentId takes the whole delivery.
   */
  readonly routesEachEntry?: true;
  canHandle(req: ChannelRequest): boolean;
  authenticate(req: ChannelRequest): boolean | Promise<boolean>;
  /**
   * Async when a channel must check external state before deciding to run the
   * agent.
   */
  parse(req: ChannelRequest): ChannelParseResult | Promise<ChannelParseResult>;
  actions(msg: InboundMessage): ChannelActions;
  /**
   * Rewrite the reply routing a channel record's `replyIn` asks for.
   * Only providers where the runtime chooses between a thread and the channel
   * implement it; the rest have one place to reply and omit it.
   */
  applyReplyIn?(
    source: Record<string, unknown>,
    replyIn: ChannelReplyIn,
  ): Record<string, unknown>;
  /**
   * Rebuild the reader for an attachment named only by its `fetchMetadata`,
   * so a picture can be downloaded again on a later turn. Providers whose SDK
   * adapter implements it delegate straight to the transport; the rest omit it
   * and their attachments are re-read from the URL they arrived with.
   */
  rehydrateAttachment?(attachment: Attachment): Attachment;
}

/**
 * Bytes for an attachment, for providers that upload rather than fetch. A
 * workspace file arrives with `fetchData` so the object is read straight from
 * storage and only when a provider asks; a picture named by public URL has no
 * such reader. The model picks that URL, so it goes through the same pinned
 * guard as an inbound attachment: no private or metadata address, no other
 * scheme, no unbounded body.
 */
export async function channelAttachmentBytes(
  attachment: ChannelFile | ChannelImage,
): Promise<Buffer> {
  if (attachment.fetchData) {
    return await attachment.fetchData();
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

/**
 * Providers decide whether to preview a file from its name, so a nameless
 * upload would arrive extensionless and render as a generic download. Workspace
 * files are named already; this is for a picture named only by URL.
 */
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

/**
 * Splits a reply into pieces a provider with a hard length cap accepts, never
 * inside a surrogate pair. Zalo and Twilio send each piece as its own message.
 */
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

export function formatChannelErrorText(error: string): string {
  return `⚠️ ${simplifyErrorText(error)}`;
}

/**
 * Posts a failed run's error with a way to retry it: a Retry button where the
 * provider has buttons, a line saying to reply "retry" everywhere else. Either
 * way the retry is a normal message, so the next turn picks up the kept work.
 */
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

/**
 * The reach gate. Answered from the webhook payload alone, so an unwanted room
 * or sender is dropped before any record read or policy call (the deployment
 * load still runs ahead of it). No list, or the wildcard, lets everything
 * through; an id the payload never carried matches nothing.
 */
export function isAllowedId(
  allowed: ReadonlySet<string> | null | undefined,
  id: string | undefined,
): boolean {
  if (!allowed || allowed.has(CHANNEL_REACH_WILDCARD)) return true;
  if (!id) return false;

  return allowed.has(id);
}

/**
 * Adapters call this in `parse`, after `authenticate`, instead of a bare
 * `JSON.parse`. A malformed or non-object body is logged without its content
 * and comes back as an `invalid_payload` ignore the adapter returns as is.
 */
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

  // The one cast: the object is the provider payload the adapter's type describes.
  return { kind: "payload", payload: result.data as T };
}

/** The click a button id stands for; undefined when it is not a question button. */
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

/** The id a channel puts on one ask_questions option button. */
export function questionButtonId(
  statusId: string,
  questionIndex: number,
  optionIndex: number,
): string {
  return `q:${statusId}:${questionIndex}:${optionIndex}`;
}

/**
 * No list stays null, which the reach gate reads as open. An empty `Set` means
 * the opposite, so the distinction cannot be dropped at the call site.
 */
export function reachSet(ids: string[] | undefined): Set<string> | null {
  return ids ? new Set(ids) : null;
}

// Provider/runtime errors reach the chat wrapped ("Failed after 6 attempts. Last
// error: AI_APICallError: Request too large for gpt-6-luna in organization …").
// Keep the provider's own reason so the chat says what actually failed, drop the
// wrappers, org ids and docs links, and add the one step that fixes it.
function simplifyErrorText(raw: string): string {
  const message = (raw.match(/Last error:\s*(.+)$/is)?.[1] ?? raw)
    .replace(/^AI_\w+:\s*/, "")
    .replace(/\s+in organization \S+/i, "")
    .replace(/\s*Visit https?:\/\/\S+[^.]*\.?/gi, "")
    .trim();
  if (!message) {
    return "Something went wrong while generating a reply. Try again.";
  }
  if (
    /request too large|context (length|window)|prompt is too long/i.test(
      message,
    )
  ) {
    return withHint(
      message,
      "Send /compact to shorten the conversation, or /new to start over.",
    );
  }
  if (
    /usage limit|quota|insufficient.*credit|credit balance|purchase credits|upgrade your (token )?plan/i.test(
      message,
    )
  ) {
    return withHint(
      message,
      "Add credits or upgrade the plan with the model provider.",
    );
  }
  if (/try again in/i.test(message)) {
    return message;
  }
  if (/rate.?limit|\b429\b|too many requests|overloaded/i.test(message)) {
    return withHint(message, "Try again in a moment.");
  }
  if (/timed? ?out|etimedout|econnreset|network/i.test(message)) {
    return withHint(message, "Try again.");
  }

  return message;
}

function withHint(message: string, hint: string): string {
  return `${message.replace(/[\s.]+$/, "")}. ${hint}`;
}
