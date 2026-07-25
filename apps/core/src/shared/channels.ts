/**
 * Shared channel contracts.
 * Define the shared HTTP and channel adapter boundaries for inbound webhook traffic.
 */

import type { SystemModelMessage, UserContent, UserModelMessage } from "ai";
import type { StreamOptions } from "chat";

export type ChannelIngressEvent =
  UserModelMessage | (SystemModelMessage & { persist?: false });

export interface ChannelActions {
  sendText(text: string): Promise<void>;
  sendTyping(): Promise<void>;
  reactToMessage(): Promise<void>;
  // Optional native SDK/platform streaming. Channels omit it when the provider
  // lacks SDK streaming support, in which case the harness sends one final reply.
  stream?(
    textStream: AsyncIterable<unknown>,
    options?: StreamOptions,
  ): Promise<string | null>;
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
  actorId?: string;
  /** Display name for that person, when the provider gives one cheaply. */
  actorName?: string;
  /** Roles that person holds in this channel. Filled from the channel record. */
  actorRoles?: string[];
}

export interface InboundMessage {
  eventId: string;
  conversationKey: string;
  channelName: string;
  content: UserContent;
  events?: ChannelIngressEvent[];
  identity?: ChannelIdentity;
  source: Record<string, unknown>;
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
 * Channel parse results describe what the webhook should do before the agent runs.
 * Some providers need an immediate HTTP response, while others can be acknowledged and processed later.
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
   * Normalize a webhook request into a channel message, provider response, or ignored event.
   * Parsing may be async when a channel must check external state before deciding to run the agent.
   */
  parse(req: ChannelRequest): ChannelParseResult | Promise<ChannelParseResult>;
  actions(msg: InboundMessage): ChannelActions;
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

export function isOpenAllowList(raw: string | undefined): boolean {
  return !raw || raw.trim() === "" || raw.trim().toLowerCase() === "open";
}

export function formatChannelErrorText(error: string): string {
  return `⚠️ ${simplifyErrorText(error)}`;
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
    return "Usage limit reached — add credits or upgrade your plan, then try again.";
  }
  if (/rate.?limit|\b429\b|too many requests/i.test(message)) {
    return "The model is busy right now — please try again in a moment.";
  }
  if (/timed? ?out|etimedout|econnreset|network/i.test(message)) {
    return "The request timed out — please try again.";
  }
  message = message.replace(/\s*\(\d{3,}\)\s*$/, "").trim(); // drop trailing provider codes like (2056)

  return (
    message ||
    "Something went wrong while generating a reply — please try again."
  );
}
