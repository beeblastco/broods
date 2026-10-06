/**
 * WhatsApp channel adapter, on the WhatsApp Business Cloud API. The Chat SDK
 * adapter is the transport: it checks Meta's signature, reads the message and
 * posts the reply. Meta's GET subscription handshake is answered here too,
 * because it arrives on the same webhook URL.
 */

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
// The part of Graph's media lookup the download needs.
const MEDIA_LOOKUP = z.looseObject({ url: z.string() });

type WhatsAppInboundMessage = WhatsAppRawMessage["message"];

// One message from a delivery, with the contact Meta sent for its sender.
interface WhatsAppInbound {
  contact: WhatsAppRawMessage["contact"];
  message: WhatsAppInboundMessage;
}

// The change notification Meta posts. Only a `messages` change for this
// number carries something to answer; statuses ride the same field.
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

// The SDK keeps the signature check and its Graph API call protected, so this
// subclass is an access shim, plus the guarded media download and the tenant
// `apiUrl` guard on the Graph API calls.
class BroodsWhatsAppAdapter extends WhatsAppAdapter {
  private get tenantApiUrl(): boolean {
    return new URL(this.graphApiUrl).host !== "graph.facebook.com";
  }

  // The download URL is whatever the media lookup answers, and a custom
  // `apiUrl` is the tenant's own server, so both hops take the private-address
  // guard and size cap every channel's media gets.
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

  // The SDK finds the message to type against in Chat state, which core does
  // not keep, so the inbound message id is passed in.
  async sendTypingIndicator(messageId: string): Promise<void> {
    await this.graphApiRequest(`/${this.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  }

  // A tenant `apiUrl` is their host, so the access token only goes there
  // pinned to a checked public address with redirects refused.
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

/**
 * Builds the WhatsApp adapter from one agent's `config.channels.whatsapp`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
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
      // Meta can batch several messages into one POST; each is its own turn.
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
        // One body for both: the SDK picks image or document from each
        // attachment's type, uploading bytes it can read and linking the rest.
        sendFiles: sendAttachments,
        sendImages: sendAttachments,
        sendText: async function (text): Promise<void> {
          await transport.postMessage(source.threadId, { markdown: text });
        },
        sendTyping: function (): Promise<void> {
          return transport.sendTypingIndicator(source.messageId);
        },
        supportsReactions: true,
        // No automatic acknowledgement: the typing indicator already marks the
        // message read, so only an explicit emoji from the agent is sent.
        reactToMessage: async function (emoji): Promise<void> {
          if (!emoji) return;
          await transport.addReaction(source.threadId, source.messageId, emoji);
        },
      };
    },
  };
}

// Every message Meta sent for this number, each with its sender's contact. A
// Meta app can hold several numbers, so a change for another one is not ours,
// and a status-only change (a read receipt) carries no message to find.
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

// Meta sends the handshake as `hub.*` query parameters on a GET.
function handshakeParams(req: ChannelRequest): URLSearchParams {
  return new URLSearchParams(req.rawQueryString);
}

// The turn one inbound message becomes, or why it is not one.
function parseInbound(
  inbound: WhatsAppInbound,
  transport: BroodsWhatsAppAdapter,
  options: WhatsAppChannelOptions,
): ParsedChannelMessage | { kind: "ignore"; reason: string } {
  const { contact, message } = inbound;
  if (message.type === "reaction") {
    return { kind: "ignore", reason: "no message for this number" };
  }
  if (
    !isAllowedId(options.allowedChannelIds, message.from) ||
    !isAllowedId(options.allowedUserIds, message.from)
  ) {
    logWarn("WhatsApp sender not in allow list", { userId: message.from });

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
    message: toInboundMessage(message, parsed, text),
  };
}

// A tapped button or list row carries its label, which the SDK does not read
// as text. Undefined for every other message type.
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

// The turn one verified message becomes. A WhatsApp chat is always one person,
// so the sender is also the place the reply goes.
function toInboundMessage(
  message: WhatsAppInboundMessage,
  parsed: Message<WhatsAppRawMessage>,
  text: string,
): InboundMessage {
  const userName = parsed.raw.contact?.profile.name;
  const source: WhatsAppSource = {
    messageId: message.id,
    phoneNumberId: parsed.raw.phoneNumberId,
    threadId: parsed.threadId,
    userWaId: message.from,
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
      channelId: message.from,
      userId: message.from,
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
