/** Shared HTTP and channel adapter contracts for inbound webhook traffic. */

import type { SystemModelMessage, UserContent, UserModelMessage } from "ai";
import type { Attachment, StreamOptions } from "chat";
import type { ChannelReplyIn } from "./domain/channel-record.ts";

/** Reach every room or sender, instead of only the listed ids. */
export const CHANNEL_REACH_WILDCARD = "*";

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
   * sent. Adapters name the attachment and leave the bytes alone: parsing runs
   * before the webhook is acknowledged, so downloading there would hold the
   * provider's connection open for the length of a video. `fetchData` is the
   * adapter's own authenticated reader (Telegram resolves a file id through
   * getFile and signs the download with the bot token; Slack sends a bearer header
   * for a private file), called once the turn is already running.
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
  | ParsedChannelCleanup
  | { kind: "ignore"; reason?: string; response?: ChannelResponse }
  | { kind: "response"; reason?: string; response: ChannelResponse };

export interface ChannelAdapter {
  readonly name: string;
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
 * such reader, so it is fetched the same way the provider would have.
 */
export async function channelAttachmentBytes(
  attachment: ChannelFile | ChannelImage,
): Promise<Buffer> {
  if (attachment.fetchData) {
    return await attachment.fetchData();
  }
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(
      `Could not read ${attachment.name ?? attachment.url} to upload it (${response.status})`,
    );
  }

  return Buffer.from(await response.arrayBuffer());
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
 * No list stays null, which the reach gate reads as open. An empty `Set` means
 * the opposite, so the distinction cannot be dropped at the call site.
 */
export function reachSet(ids: string[] | undefined): Set<string> | null {
  return ids ? new Set(ids) : null;
}

// Provider/runtime errors reach the chat raw and ugly ("Failed after 3 attempts.
// Last error: Token Plan usage limit reached … (2056)"). Strip the retry wrapper
// and map the common conditions to one short, actionable line; otherwise pass the
// cleaned message through so unexpected errors are still legible.
function simplifyErrorText(raw: string): string {
  const afterRetry = raw.match(/Last error:\s*(.+)$/is);
  let message = (afterRetry?.[1] ?? raw).trim();
  if (
    /usage limit|quota|insufficient.*credit|purchase credits|upgrade your (token )?plan/i.test(
      message,
    )
  ) {
    return "Usage limit reached. Add credits or upgrade your plan, then try again.";
  }
  if (/rate.?limit|\b429\b|too many requests/i.test(message)) {
    return "The model is busy right now. Try again in a moment.";
  }
  if (/timed? ?out|etimedout|econnreset|network/i.test(message)) {
    return "The request timed out. Try again.";
  }
  message = message.replace(/\s*\(\d{3,}\)\s*$/, "").trim(); // drop trailing provider codes like (2056)

  return message || "Something went wrong while generating a reply. Try again.";
}
