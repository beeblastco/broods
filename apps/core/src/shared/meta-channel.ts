/**
 * What Messenger and Instagram share. Both deliver Meta Graph webhooks: a GET
 * subscription handshake answered with the verify token, an
 * `X-Hub-Signature-256` HMAC over every POST, and one envelope of batched
 * messaging events whose entries each name the Page or account they are for.
 * Both reply through a Chat SDK adapter used as transport only. Each channel
 * file builds its transport and names how the two differ.
 */

import { createHmac } from "node:crypto";
import type { AdapterPostableMessage, Attachment, Message } from "chat";
import { timingSafeStringEqual } from "./auth.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelFile,
  ChannelImage,
  ChannelParseResult,
  ChannelRequest,
  ParsedChannelMessage,
} from "./channels.ts";
import { isAllowedId, parseChannelWebhookBody } from "./channels.ts";
import { logWarn } from "./log.ts";

const SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * The fields of one Messenger or Instagram messaging event read here. Both
 * adapters' event types satisfy it; only Instagram sets the two flags for a
 * deleted or unsupported message.
 */
export interface MetaMessagingEvent {
  message?: {
    attachments?: readonly unknown[];
    is_deleted?: boolean;
    is_echo?: boolean;
    is_unsupported?: boolean;
    mid: string;
    text?: string;
  };
  postback?: { mid?: string; title: string };
  recipient: { id: string };
  sender: { id: string };
  timestamp: number;
}

/**
 * Where a Messenger or Instagram message came from. `recipientId` is the Page
 * or Instagram professional account that received it; `threadId` is the Chat
 * SDK thread the reply goes to.
 */
export interface MetaSource {
  messageId: string;
  recipientId: string;
  senderId: string;
  threadId: string;
}

/** The part of a Chat SDK Meta adapter a channel drives. */
export interface MetaTransport<Event extends MetaMessagingEvent> {
  parseMessage(raw: Event): Message<Event>;
  postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<unknown>;
  startTyping(threadId: string): Promise<void>;
}

export interface MetaChannelOptions<Event extends MetaMessagingEvent> {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  appSecret: string;
  name: "instagram" | "messenger";
  /** The Page or account this agent answers for; only its entries run. */
  ownerId(): Promise<string>;
  /** The webhook `object` this channel subscribes to. */
  object: "instagram" | "page";
  /** Whether the transport's `postMessage` delivers attachments. */
  postsAttachments: boolean;
  prefix: string;
  /** Reply chunk size, counted the way the platform counts it. */
  textLimit: MetaTextLimit;
  transport: MetaTransport<Event>;
  verifyToken: string;
}

interface MetaTextLimit {
  max: number;
  unit: "bytes" | "chars";
}

// One messaging event and the Page or account its entry names.
interface MetaEvent<Event> {
  event: Event;
  recipientId: string;
}

interface MetaWebhookPayload<Event> {
  object?: string;
  entry?: { id: string; messaging?: Event[] }[];
}

/**
 * The adapter behind `messenger-channel.ts` and `instagram-channel.ts`. It
 * answers the GET handshake itself, turns every message of a delivery sent to
 * its own Page or account into a turn and replies through the Chat SDK
 * transport.
 */
export function createMetaChannel<Event extends MetaMessagingEvent>(
  options: MetaChannelOptions<Event>,
): ChannelAdapter {
  const { name, transport } = options;

  return {
    name: name,
    // One Meta app can serve several Pages or accounts, each its own agent's.
    routesEachEntry: true,

    canHandle: function (req): boolean {
      if (req.method === "GET") {
        return handshakeParams(req).has("hub.mode");
      }

      return SIGNATURE_HEADER in req.headers;
    },

    authenticate: function (req): boolean {
      if (req.method === "GET") {
        const params = handshakeParams(req);
        const token = params.get("hub.verify_token");

        return (
          params.get("hub.mode") === "subscribe" &&
          token !== null &&
          timingSafeStringEqual(token, options.verifyToken)
        );
      }
      const signature = req.headers[SIGNATURE_HEADER];
      const expected = `sha256=${createHmac("sha256", options.appSecret)
        .update(req.body, "utf8")
        .digest("hex")}`;
      if (
        signature === undefined ||
        !timingSafeStringEqual(signature, expected)
      ) {
        logWarn("Meta webhook signature verification failed", {
          channel: name,
        });

        return false;
      }

      return true;
    },

    parse: async function (req): Promise<ChannelParseResult> {
      if (req.method === "GET") {
        return {
          kind: "response",
          reason: "subscription handshake",
          response: {
            statusCode: 200,
            headers: { "content-type": "text/plain" },
            body: handshakeParams(req).get("hub.challenge") ?? "",
          },
        };
      }
      const body = parseChannelWebhookBody<MetaWebhookPayload<Event>>(
        name,
        req.body,
      );
      if (body.kind === "ignore") {
        return body;
      }
      if (body.payload.object !== options.object) {
        return { kind: "ignore", reason: "not a messaging subscription" };
      }
      const events = messageEvents(body.payload);
      if (events.length === 0) {
        return { kind: "ignore", reason: "no message" };
      }
      // Meta batches events under load; each message is its own turn.
      const ownerId = await options.ownerId();
      const results = events
        .filter((found) => found.recipientId === ownerId)
        .map((found) => parseEvent(options, found));
      const messages = results.filter((result) => result.kind === "message");
      if (messages.length > 1) {
        return { kind: "batch", results: messages };
      }

      return (
        messages[0] ??
        results[0] ?? { kind: "ignore", reason: "no message for this owner" }
      );
    },

    actions: function (msg): ChannelActions {
      const source = toMetaSource(name, msg.source);

      const sendText = async function (text: string): Promise<void> {
        for (const chunk of splitMetaText(text, options.textLimit)) {
          await transport.postMessage(source.threadId, { markdown: chunk });
        }
      };

      // One body for both: the SDK uploads bytes it can read and links the
      // rest. The caption goes through sendText, since the SDK truncates it.
      const sendAttachments = async function (
        attachments: ChannelFile[] | ChannelImage[],
        caption?: string,
      ): Promise<void> {
        await transport.postMessage(source.threadId, {
          markdown: "",
          attachments: attachments,
        });
        if (caption) {
          await sendText(caption);
        }
      };

      return {
        ...(options.postsAttachments
          ? { sendFiles: sendAttachments, sendImages: sendAttachments }
          : {}),
        sendText: sendText,
        sendTyping: function (): Promise<void> {
          return transport.startTyping(source.threadId);
        },
        // Neither Send API lets a Page or account react to a message.
        reactToMessage: async function (): Promise<void> {
          return;
        },
      };
    },
  };
}

// Meta sends the handshake as `hub.*` query parameters on a GET.
function handshakeParams(req: ChannelRequest): URLSearchParams {
  return new URLSearchParams(req.rawQueryString);
}

/**
 * Every event in a delivery a person sent: a message or a button tap, with the
 * Page or account it was sent to. Echoes of the agent's own replies,
 * reactions, reads and deliveries are never messages.
 */
function messageEvents<Event extends MetaMessagingEvent>(
  payload: MetaWebhookPayload<Event>,
): MetaEvent<Event>[] {
  return (payload.entry ?? []).flatMap((entry) =>
    (entry.messaging ?? [])
      .filter((event) => {
        const message = event.message;
        const isMessage =
          message !== undefined &&
          !message.is_echo &&
          !message.is_deleted &&
          !message.is_unsupported;

        return isMessage || event.postback !== undefined;
      })
      .map((event) => ({ event: event, recipientId: entry.id })),
  );
}

// One person's message as a turn, or why it does not run.
function parseEvent<Event extends MetaMessagingEvent>(
  options: MetaChannelOptions<Event>,
  found: MetaEvent<Event>,
): ParsedChannelMessage | { kind: "ignore"; reason: string } {
  const senderId = found.event.sender.id;
  if (
    !isAllowedId(options.allowedChannelIds, senderId) ||
    !isAllowedId(options.allowedUserIds, senderId)
  ) {
    logWarn("Meta sender not in allow list", {
      channel: options.name,
      userId: senderId,
    });

    return { kind: "ignore", reason: "not allowed" };
  }
  const parsed = options.transport.parseMessage(found.event);
  const attachments = urlAttachments(parsed.attachments);
  if (!parsed.text.trim() && attachments.length === 0) {
    return { kind: "ignore", reason: "empty message" };
  }
  const source: MetaSource = {
    messageId: parsed.id,
    recipientId: found.recipientId,
    senderId: senderId,
    threadId: parsed.threadId,
  };

  return {
    kind: "message",
    message: {
      eventId: `${options.prefix}${senderId}:${parsed.id}`,
      conversationKey: `${options.prefix}${found.recipientId}:${senderId}`,
      channelName: options.name,
      content: parsed.text,
      ...(attachments.length > 0 ? { attachments: attachments } : {}),
      // A Messenger or Instagram chat is always one person, so the sender is
      // also the place the reply goes.
      identity: {
        workspaceRef: found.recipientId,
        channelId: senderId,
        userId: senderId,
      },
      // Spread so the typed source reaches a Record<string, unknown> field.
      source: { ...source },
    },
  };
}

/**
 * Cuts a reply into pieces the Send API takes whole, since both adapters
 * truncate past their limit. Breaks at the last whitespace in the back half of
 * a piece, and never inside a code point.
 */
function splitMetaText(text: string, limit: MetaTextLimit): string[] {
  const size = (value: string): number =>
    limit.unit === "bytes" ? Buffer.byteLength(value, "utf8") : value.length;
  const chunks: string[] = [];
  let current = "";
  let currentSize = 0;
  for (const codePoint of text.trim()) {
    const codePointSize = size(codePoint);
    if (currentSize + codePointSize > limit.max) {
      const space = Math.max(
        current.lastIndexOf("\n"),
        current.lastIndexOf(" "),
      );
      const cut = space > current.length / 2 ? space : current.length;
      chunks.push(current.slice(0, cut));
      current = current.slice(cut);
      currentSize = size(current);
    }
    current += codePoint;
    currentSize += codePointSize;
  }
  chunks.push(current);

  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

function toMetaSource(
  name: string,
  source: Record<string, unknown>,
): MetaSource {
  if (
    typeof source.messageId !== "string" ||
    typeof source.recipientId !== "string" ||
    typeof source.senderId !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error(`Invalid ${name} source payload`);
  }

  return {
    messageId: source.messageId,
    recipientId: source.recipientId,
    senderId: source.senderId,
    threadId: source.threadId,
  };
}

/**
 * Inbound media as plain URL attachments. The adapters attach a reader that
 * downloads with a bare fetch and no size cap; without it the harness reads
 * the URL through its guarded, capped fetch. Meta CDN links are signed in the
 * URL, so the download needs no token.
 */
function urlAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.flatMap((attachment): Attachment[] =>
    attachment.url ? [{ type: attachment.type, url: attachment.url }] : [],
  );
}
