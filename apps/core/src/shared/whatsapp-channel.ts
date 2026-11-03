import {
  WhatsAppAdapter,
  type WhatsAppRawMessage,
} from "@chat-adapter/whatsapp";
import { ConsoleLogger, type Message } from "chat";
import { z } from "zod";
import {
  FETCH_TIMEOUT_MS,
  guardedFetch,
} from "../harness/isolate/runner/pinned-fetch.mjs";
import { timingSafeStringEqual } from "./auth.ts";
import { publicHostFetch } from "./http.ts";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelFile,
  ChannelImage,
  ChannelParseResult,
  ChannelRequest,
  InboundMessage,
  ParsedChannelMessage,
} from "./channels.ts";
import { isAllowedId, parseChannelWebhookBody } from "./channels.ts";
import { logWarn } from "./log.ts";
import { MAX_ATTACHMENT_BYTES } from "./media-types.ts";
import { WHATSAPP_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const WHATSAPP_SIGNATURE_HEADER = "x-hub-signature-256";
const WHATSAPP_DEFAULT_USER_NAME = "whatsapp-bot";
const MEDIA_LOOKUP = z.looseObject({ url: z.string() });

type WhatsAppInboundMessage = WhatsAppRawMessage["message"];

interface WhatsAppInbound {
  contact: WhatsAppRawMessage["contact"];
  message: WhatsAppInboundMessage;
}

interface WhatsAppWebhookPayload {
  entry?: {
    changes?: {
      field?: string;
      value?: {
        contacts?: NonNullable<WhatsAppRawMessage["contact"]>[];
        messages?: WhatsAppInboundMessage[];
        metadata?: { phone_number_id?: string };
      };
    }[];
  }[];
}

export interface WhatsAppChannelOptions {
  accessToken: string;
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiUrl?: string;
  apiVersion?: string;
  appSecret: string;
  phoneNumberId: string;
  userName?: string;
  verifyToken: string;
}

export interface WhatsAppSource {
  messageId: string;
  phoneNumberId: string;
  threadId: string;
  userName?: string;
  userWaId: string;
}

// Exposes the SDK's protected signature check and guards every fetch a tenant can steer.
class BroodsWhatsAppAdapter extends WhatsAppAdapter {
  private get tenantApiUrl(): boolean {
    return new URL(this.graphApiUrl).host !== "graph.facebook.com";
  }

  // A tenant apiUrl answers the download URL, so both hops get the address guard and size cap.
  override async downloadMedia(mediaId: string): Promise<Buffer> {
    const auth = { headers: { authorization: `Bearer ${this.accessToken}` } };
    const lookup = await guardedFetch(`${this.graphApiUrl}/${mediaId}`, auth);
    if (lookup.status < 200 || lookup.status >= 300) {
      throw new Error(`WhatsApp media lookup answered ${lookup.status}`);
    }
    const media = MEDIA_LOOKUP.parse(JSON.parse(lookup.bodyText));
    const download = await guardedFetch(media.url, auth, {
      binary: true,
      bodyLimitBytes: MAX_ATTACHMENT_BYTES,
    });
    if (download.status < 200 || download.status >= 300) {
      throw new Error(`WhatsApp media download answered ${download.status}`);
    }

    return Buffer.from(download.bodyBytes);
  }

  protected override graphApiRequest<T = unknown>(
    path: string,
    body: unknown,
  ): Promise<T> {
    if (!this.tenantApiUrl) return super.graphApiRequest(path, body);

    return this.tenantGraphApi(path, {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    });
  }

  protected override graphApiUpload<T = unknown>(
    path: string,
    formData: FormData,
  ): Promise<T> {
    if (!this.tenantApiUrl) return super.graphApiUpload(path, formData);

    return this.tenantGraphApi(path, { body: formData });
  }

  verifyWebhookSignature(body: string, signature: string | undefined): boolean {
    return this.verifySignature(body, signature ?? null);
  }

  // Core keeps no Chat state for the SDK to find the message in, so its id is passed in.
  async sendTypingIndicator(messageId: string): Promise<void> {
    await this.graphApiRequest(`/${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  }

  private async tenantGraphApi<T>(
    path: string,
    init: { body: string | FormData; headers?: Record<string, string> },
  ): Promise<T> {
    const response = await publicHostFetch(`${this.graphApiUrl}${path}`, {
      method: "POST",
      body: init.body,
      headers: { Authorization: `Bearer ${this.accessToken}`, ...init.headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `WhatsApp API error: ${response.status} ${await response.text()}`,
      );
    }

    return (await response.json()) as T;
  }
}

export function createWhatsAppChannel(
  options: WhatsAppChannelOptions,
): ChannelAdapter {
  const transport = new BroodsWhatsAppAdapter({
    accessToken: options.accessToken,
    apiUrl: options.apiUrl,
    apiVersion: options.apiVersion,
    appSecret: options.appSecret,
    logger: new ConsoleLogger("error").child("whatsapp"),
    phoneNumberId: options.phoneNumberId,
    userName: options.userName ?? WHATSAPP_DEFAULT_USER_NAME,
    verifyToken: options.verifyToken,
  });

  return {
    name: "whatsapp",
    // One Meta app holds several numbers, each possibly its own agent's.
    routesEachEntry: true,

    rehydrateAttachment: function (attachment) {
      return transport.rehydrateAttachment(attachment);
    },

    canHandle: function (req) {
      if (req.method === "GET") {
        return handshakeParams(req).has("hub.mode");
      }

      return WHATSAPP_SIGNATURE_HEADER in req.headers;
    },

    authenticate: function (req) {
      if (req.method === "GET") {
        const params = handshakeParams(req);
        const token = params.get("hub.verify_token");

        return (
          params.get("hub.mode") === "subscribe" &&
          token !== null &&
          timingSafeStringEqual(token, options.verifyToken)
        );
      }
      if (
        !transport.verifyWebhookSignature(
          req.body,
          req.headers[WHATSAPP_SIGNATURE_HEADER],
        )
      ) {
        logWarn("WhatsApp webhook signature verification failed");

        return false;
      }

      return true;
    },

    parse: function (req): ChannelParseResult {
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
      const body = parseChannelWebhookBody<WhatsAppWebhookPayload>(
        "whatsapp",
        req.body,
      );
      if (body.kind === "ignore") {
        return body;
      }
      const results = findInboundMessages(
        body.payload,
        options.phoneNumberId,
      ).map((inbound) => parseInbound(inbound, transport, options));
      const messages = results.filter((result) => result.kind === "message");
      if (messages.length > 1) {
        return { kind: "batch", results: messages };
      }

      return (
        messages[0] ??
        results[0] ?? { kind: "ignore", reason: "no message for this number" }
      );
    },

    actions: function (msg): ChannelActions {
      const source = toWhatsAppSource(msg.source);

      const sendAttachments = async function (
        attachments: ChannelFile[] | ChannelImage[],
        caption?: string,
      ): Promise<void> {
        await transport.postMessage(source.threadId, {
          markdown: caption ?? "",
          attachments: attachments,
        });
      };

      return {
        sendFiles: sendAttachments,
        sendImages: sendAttachments,
        sendText: async function (text): Promise<void> {
          await transport.postMessage(source.threadId, { markdown: text });
        },
        sendTyping: function (): Promise<void> {
          return transport.sendTypingIndicator(source.messageId);
        },
        supportsReactions: true,
        // No automatic ack: the typing indicator already marks the message read.
        reactToMessage: async function (emoji): Promise<void> {
          if (!emoji) return;
          await transport.addReaction(source.threadId, source.messageId, emoji);
        },
      };
    },
  };
}

function findInboundMessages(
  payload: WhatsAppWebhookPayload,
  phoneNumberId: string,
): WhatsAppInbound[] {
  return (payload.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .filter(
      (change) =>
        change.field === "messages" &&
        change.value?.metadata?.phone_number_id === phoneNumberId,
    )
    .flatMap((change) =>
      (change.value?.messages ?? []).map((message) => ({
        contact: change.value?.contacts?.find(
          (candidate) => candidate.wa_id === message.from,
        ),
        message: message,
      })),
    );
}

function handshakeParams(req: ChannelRequest): URLSearchParams {
  return new URLSearchParams(req.rawQueryString);
}

function parseInbound(
  inbound: WhatsAppInbound,
  transport: BroodsWhatsAppAdapter,
  options: WhatsAppChannelOptions,
): ParsedChannelMessage | { kind: "ignore"; reason: string } {
  const { contact, message } = inbound;
  if (message.type === "reaction") {
    return { kind: "ignore", reason: "no message for this number" };
  }
  // A username-only sender carries no phone number to allow-list or reply to.
  const from = message.from;
  if (!from) {
    logWarn("WhatsApp sender has no phone number", { messageId: message.id });

    return { kind: "ignore", reason: "no sender phone number" };
  }
  if (
    !isAllowedId(options.allowedChannelIds, from) ||
    !isAllowedId(options.allowedUserIds, from)
  ) {
    logWarn("WhatsApp sender not in allow list", { userId: from });

    return { kind: "ignore", reason: "not allowed" };
  }
  const parsed = transport.parseMessage({
    contact: contact,
    message: message,
    phoneNumberId: options.phoneNumberId,
  });
  const text = replyText(message) ?? parsed.text;
  if (!text && parsed.attachments.length === 0) {
    return { kind: "ignore", reason: `unsupported_type:${message.type}` };
  }

  return {
    kind: "message",
    redelivers: true,
    message: toInboundMessage(message, from, parsed, text),
  };
}

// The SDK does not read a tapped button's or list row's label as text.
function replyText(message: WhatsAppInboundMessage): string | undefined {
  if (message.type === "button") {
    return message.button?.text;
  }
  if (message.type === "interactive") {
    return (
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title
    );
  }

  return undefined;
}

// A WhatsApp chat is always one person, so the sender is also where the reply goes.
function toInboundMessage(
  message: WhatsAppInboundMessage,
  from: string,
  parsed: Message<WhatsAppRawMessage>,
  text: string,
): InboundMessage {
  const userName = parsed.raw.contact?.profile.name;
  const source: WhatsAppSource = {
    messageId: message.id,
    phoneNumberId: parsed.raw.phoneNumberId,
    threadId: parsed.threadId,
    userWaId: from,
    ...(userName ? { userName: userName } : {}),
  };

  return {
    eventId: `${WHATSAPP_INTEGRATION_PREFIX}${message.id}`,
    conversationKey: parsed.threadId,
    channelName: "whatsapp",
    content: text,
    ...(parsed.attachments.length > 0
      ? { attachments: parsed.attachments }
      : {}),
    identity: {
      channelId: from,
      userId: from,
      ...(userName ? { userName: userName } : {}),
    },
    source: { ...source },
  };
}

function toWhatsAppSource(source: Record<string, unknown>): WhatsAppSource {
  if (
    typeof source.messageId !== "string" ||
    typeof source.phoneNumberId !== "string" ||
    typeof source.threadId !== "string" ||
    typeof source.userWaId !== "string"
  ) {
    throw new Error("Invalid WhatsApp source payload");
  }

  return {
    messageId: source.messageId,
    phoneNumberId: source.phoneNumberId,
    threadId: source.threadId,
    userWaId: source.userWaId,
    ...(typeof source.userName === "string"
      ? { userName: source.userName }
      : {}),
  };
}
