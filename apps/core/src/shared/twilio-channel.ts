/**
 * Twilio channel adapter, for SMS and MMS on a Twilio number or Messaging
 * Service. The Chat SDK adapter is the transport: it checks Twilio's
 * signature, reads the form Twilio posts and sends the reply. SMS has no typing
 * indicator and no reactions, so those actions do nothing.
 */

import { TwilioAdapter } from "@chat-adapter/twilio";
import {
  parseTwilioWebhookBody,
  TwilioWebhookVerificationError,
  verifyTwilioRequest,
} from "@chat-adapter/twilio/webhook";
import { ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
  ChannelResponse,
} from "./channels.ts";
import { chunkChannelText, isAllowedId } from "./channels.ts";
import { logWarn } from "./log.ts";
import { TWILIO_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";
const TWILIO_DEFAULT_USER_NAME = "twilio-bot";
// Twilio joins up to ten segments into one message and refuses anything longer.
const TWILIO_TEXT_LIMIT = 1600;
// Twilio reads the webhook answer as TwiML. An empty one sends no reply of its
// own, since the agent replies through the API once it has run.
const TWIML_EMPTY: ChannelResponse = {
  statusCode: 200,
  headers: { "content-type": "application/xml" },
  body: "<Response></Response>",
};

export interface TwilioChannelOptions {
  accountSid: string;
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiUrl?: string;
  authToken: string;
  messagingServiceSid?: string;
  phoneNumber?: string;
  /** Where core is reached publicly; the signed URL is this plus the request path. */
  publicBaseUrl?: string;
  statusCallbackUrl?: string;
  userName?: string;
  webhookUrl?: string;
}

export interface TwilioSource {
  /** The person's number, where the reply goes. */
  from: string;
  messageSid: string;
  /** The Twilio number they texted. */
  to: string;
}

/**
 * Builds the Twilio adapter from one agent's `config.channels.twilio`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
export function createTwilioChannel(
  options: TwilioChannelOptions,
): ChannelAdapter {
  const transport = new TwilioAdapter({
    accountSid: options.accountSid,
    apiUrl: options.apiUrl,
    authToken: options.authToken,
    logger: new ConsoleLogger("error").child("twilio"),
    messagingServiceSid: options.messagingServiceSid,
    phoneNumber: options.phoneNumber,
    statusCallbackUrl: options.statusCallbackUrl,
    userName: options.userName ?? TWILIO_DEFAULT_USER_NAME,
  });

  return {
    name: "twilio",

    rehydrateAttachment: function (attachment) {
      return transport.rehydrateAttachment(attachment);
    },

    canHandle: function (req) {
      return req.method === "POST" && TWILIO_SIGNATURE_HEADER in req.headers;
    },

    // Twilio signs the URL it called plus every form field, so the check needs
    // the public URL, not the one core was reached on behind the gateway.
    authenticate: async function (req): Promise<boolean> {
      const url =
        options.webhookUrl ??
        (options.publicBaseUrl
          ? `${options.publicBaseUrl}${req.rawPath}${req.rawQueryString ? `?${req.rawQueryString}` : ""}`
          : undefined);
      if (!url) {
        logWarn(
          "Twilio webhook cannot be verified: set webhookUrl or PUBLIC_BASE_URL",
        );

        return false;
      }
      try {
        await verifyTwilioRequest(
          new Request(url, {
            method: "POST",
            headers: req.headers,
            body: req.body,
          }),
          { authToken: options.authToken, webhookUrl: url },
        );
      } catch (error) {
        if (!(error instanceof TwilioWebhookVerificationError)) throw error;
        logWarn("Twilio webhook signature verification failed");

        return false;
      }

      return true;
    },

    parse: function (req): ChannelParseResult {
      const payload = parseTwilioWebhookBody(new URLSearchParams(req.body));
      // Delivery receipts ride the same URL when statusCallbackUrl points here.
      if (payload.kind !== "text") {
        return {
          kind: "ignore",
          reason: `unsupported:${payload.kind}`,
          response: TWIML_EMPTY,
        };
      }
      if (!payload.messageSid) {
        return {
          kind: "ignore",
          reason: "missing_message_sid",
          response: TWIML_EMPTY,
        };
      }
      // One Twilio account can point several numbers at the same URL.
      if (options.phoneNumber && payload.to !== options.phoneNumber) {
        return {
          kind: "ignore",
          reason: "another number",
          response: TWIML_EMPTY,
        };
      }
      if (
        !isAllowedId(options.allowedChannelIds, payload.from) ||
        !isAllowedId(options.allowedUserIds, payload.from)
      ) {
        logWarn("Twilio sender not in allow list", { userId: payload.from });

        return { kind: "ignore", reason: "not allowed", response: TWIML_EMPTY };
      }
      const parsed = transport.parseMessage(payload);
      if (!parsed.text && parsed.attachments.length === 0) {
        return { kind: "ignore", reason: "empty", response: TWIML_EMPTY };
      }
      const source: TwilioSource = {
        from: payload.from,
        messageSid: payload.messageSid,
        to: payload.to,
      };

      return {
        kind: "message",
        ack: TWIML_EMPTY,
        message: {
          eventId: `${TWILIO_INTEGRATION_PREFIX}${payload.messageSid}`,
          conversationKey: parsed.threadId,
          channelName: "twilio",
          content: parsed.text,
          ...(parsed.attachments.length > 0
            ? { attachments: parsed.attachments }
            : {}),
          identity: { channelId: payload.from, userId: payload.from },
          source: { ...source },
        },
      };
    },

    actions: function (msg): ChannelActions {
      const source = toTwilioSource(msg.source);
      // A Messaging Service picks the sending number itself; without one the
      // reply comes from the number the person texted.
      const threadId = transport.encodeThreadId({
        recipient: source.from,
        sender: options.messagingServiceSid ?? source.to,
      });

      return {
        sendText: async function (text): Promise<void> {
          for (const chunk of chunkChannelText(text, TWILIO_TEXT_LIMIT)) {
            await transport.postMessage(threadId, { markdown: chunk });
          }
        },
        // MMS by URL: Twilio fetches each picture itself. No sendFiles, since
        // most carriers drop documents, so `send-files` sends links instead.
        sendImages: async function (images, caption): Promise<void> {
          await transport.postMessage(threadId, {
            markdown: caption ?? "",
            attachments: images,
          });
        },
        sendTyping: async function (): Promise<void> {
          return;
        },
        reactToMessage: async function (): Promise<void> {
          return;
        },
      };
    },
  };
}

function toTwilioSource(source: Record<string, unknown>): TwilioSource {
  if (
    typeof source.from !== "string" ||
    typeof source.messageSid !== "string" ||
    typeof source.to !== "string"
  ) {
    throw new Error("Invalid Twilio source payload");
  }

  return {
    from: source.from,
    messageSid: source.messageSid,
    to: source.to,
  };
}
