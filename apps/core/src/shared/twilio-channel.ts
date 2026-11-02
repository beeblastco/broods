import { TwilioAdapter, TwilioFormatConverter } from "@chat-adapter/twilio";
import {
  parseTwilioWebhookBody,
  type TwilioWebhookPayload,
  TwilioWebhookVerificationError,
  verifyTwilioRequest,
} from "@chat-adapter/twilio/webhook";
import { type Attachment, ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
  ChannelResponse,
} from "./channels.ts";
import { guardedFetch } from "../harness/isolate/runner/pinned-fetch.mjs";
import { chunkChannelText, isAllowedId } from "./channels.ts";
import type { PinnedFetchTransport } from "./http.ts";
import { logWarn } from "./log.ts";
import { MAX_ATTACHMENT_BYTES } from "./media-types.ts";
import { TWILIO_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const TWILIO_SIGNATURE_HEADER = "x-twilio-signature";
const TWILIO_DEFAULT_USER_NAME = "twilio-bot";
// Twilio joins up to ten segments into one message and refuses anything longer.
const TWILIO_TEXT_LIMIT = 1600;
const TWILIO_FETCH_TIMEOUT_MS = 30_000;
const TWILIO_FORMAT = new TwilioFormatConverter();
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
  publicBaseUrl?: string;
  statusCallbackUrl?: string;
  transport?: PinnedFetchTransport;
  userName?: string;
  webhookUrl?: string;
}

export interface TwilioSource {
  from: string;
  messageSid: string;
  to: string;
}

export function createTwilioChannel(
  options: TwilioChannelOptions,
): ChannelAdapter {
  const transport = new TwilioAdapter({
    accountSid: options.accountSid,
    apiUrl: options.apiUrl,
    authToken: options.authToken,
    fetch: twilioFetch(options.transport),
    logger: new ConsoleLogger("error").child("twilio"),
    messagingServiceSid: options.messagingServiceSid,
    phoneNumber: options.phoneNumber,
    statusCallbackUrl: options.statusCallbackUrl,
    userName: options.userName ?? TWILIO_DEFAULT_USER_NAME,
  });

  return {
    name: "twilio",

    rehydrateAttachment: function (attachment): Attachment {
      return transport.rehydrateAttachment(attachment);
    },

    // One auth token signs every number an account points here, so a text to another number
    // must skip this agent, not be dropped by it.
    canHandle: function (req): boolean {
      if (req.method !== "POST" || !(TWILIO_SIGNATURE_HEADER in req.headers)) {
        return false;
      }
      const payload = readTwilioForm(req.body);

      return (
        payload.kind !== "text" ||
        !options.phoneNumber ||
        payload.to === options.phoneNumber
      );
    },

    // Twilio signs the URL it called, so this needs the public URL, not the one behind Traefik.
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
      const payload = readTwilioForm(req.body);
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
      const threadId = transport.encodeThreadId({
        recipient: source.from,
        sender: options.messagingServiceSid ?? source.to,
      });

      return {
        sendText: async function (text): Promise<void> {
          for (const chunk of renderTwilioText(text)) {
            await transport.postMessage(threadId, { raw: chunk });
          }
        },
        // No sendFiles: most carriers drop documents, so `send-files` sends links instead.
        sendImages: async function (images, caption): Promise<void> {
          const chunks = renderTwilioText(caption ?? "");
          for (const chunk of chunks.slice(0, -1)) {
            await transport.postMessage(threadId, { raw: chunk });
          }
          await transport.postMessage(threadId, {
            raw: chunks.at(-1) ?? "",
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

function renderTwilioText(text: string): string[] {
  return chunkChannelText(TWILIO_FORMAT.fromMarkdown(text), TWILIO_TEXT_LIMIT);
}

// Every inbound message carries `SmsStatus=received`, and the adapter reads a status with no
// Body as a delivery receipt, which drops a picture sent alone.
function readTwilioForm(body: string): TwilioWebhookPayload {
  const form = new URLSearchParams(body);
  for (const name of ["MessageStatus", "SmsStatus"]) {
    if (form.get(name) === "received") form.delete(name);
  }

  return parseTwilioWebhookBody(form);
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

// Tenant URLs whose media redirects to Twilio's CDN, which `publicHostFetch` would refuse.
function twilioFetch(
  transport: PinnedFetchTransport | undefined,
): typeof fetch {
  const request = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input;
    const body = init?.body;
    if (body != null && !(body instanceof URLSearchParams)) {
      throw new Error("Twilio requests carry a form body only");
    }
    const response = await guardedFetch(
      url,
      {
        body: body?.toString(),
        headers: Object.fromEntries(new Headers(init?.headers)),
        method: init?.method,
      },
      {
        ...transport,
        binary: true,
        bodyLimitBytes: MAX_ATTACHMENT_BYTES,
        timeoutMs: TWILIO_FETCH_TIMEOUT_MS,
      },
    );

    return new Response(response.bodyBytes, {
      headers: response.headers,
      status: response.status,
    });
  };

  return Object.assign(request, { preconnect: fetch.preconnect });
}
