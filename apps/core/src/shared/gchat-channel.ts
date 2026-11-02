import {
  GoogleChatAdapter,
  type GoogleChatEvent,
  type GoogleChatMessage,
  type GoogleChatSpace,
  type GoogleChatUser,
  type ServiceAccountCredentials,
} from "@chat-adapter/gchat";
import { ConsoleLogger, type Message } from "chat";
import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelIdentity,
  ChannelParseResult,
  InboundMessage,
} from "./channels.ts";
import { isAllowedId, parseChannelWebhookBody } from "./channels.ts";
import { logWarn } from "./log.ts";
import { GCHAT_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const SERVICE_ACCOUNT_KEY = z.looseObject({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});
// The SDK adapter caches Google's certificates and the access token, so one lives per app.
const TRANSPORT_CACHE_MAX = 100;
const transports = new Map<string, GoogleChatAdapter>();

// What a Chat app that is not a Workspace add-on is posted; an add-on gets `chat.messagePayload`.
interface GoogleChatClassicEvent {
  message?: GoogleChatMessage;
  space?: GoogleChatSpace;
  type?: string;
  user?: GoogleChatUser;
}

type GoogleChatWebhookEvent = GoogleChatEvent & GoogleChatClassicEvent;

export interface GoogleChatChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  credentials: ServiceAccountCredentials;
  endpointUrl?: string;
  googleChatProjectNumber?: string;
  userName?: string;
  workspaceAddOnServiceAccountEmail?: string;
}

export interface GoogleChatSource {
  messageName: string;
  spaceName: string;
  threadId: string;
  threadName?: string;
  userId?: string;
  userName?: string;
}

export function createGoogleChatChannel(
  options: GoogleChatChannelOptions,
): ChannelAdapter {
  const transport = googleChatTransport(options);

  return {
    name: "gchat",

    rehydrateAttachment: function (attachment) {
      return transport.rehydrateAttachment(attachment);
    },

    canHandle: function (req) {
      return req.method === "POST" && "authorization" in req.headers;
    },

    // The SDK keeps its token check private; with no Chat behind it, handleWebhook only
    // verifies, so a 200 means exactly "Google signed this for our audience".
    authenticate: async function (req): Promise<boolean> {
      const response = await transport.handleWebhook(
        new Request(`https://core.invalid${req.rawPath}`, {
          method: "POST",
          headers: { authorization: req.headers.authorization ?? "" },
          body: req.body,
        }),
      );
      if (response.status !== 200) {
        logWarn("Google Chat webhook token verification failed", {
          status: response.status,
        });

        return false;
      }

      return true;
    },

    parse: function (req): ChannelParseResult {
      const body = parseChannelWebhookBody<GoogleChatWebhookEvent>(
        "gchat",
        req.body,
      );
      if (body.kind === "ignore") {
        return body;
      }
      const event = addOnEvent(body.payload);
      const payload = event?.chat?.messagePayload;
      if (!event || !payload) {
        return { kind: "ignore", reason: "not a message" };
      }
      if (payload.message.sender?.type === "BOT") {
        return { kind: "ignore", reason: "bot message" };
      }
      const identity = googleChatIdentity(payload.space, payload.message);
      if (
        !isAllowedId(options.allowedChannelIds, identity.channelId) ||
        !isAllowedId(options.allowedUserIds, identity.userId)
      ) {
        logWarn("Google Chat message not in allow list", {
          channelId: identity.channelId,
          userId: identity.userId,
        });

        return { kind: "ignore", reason: "not allowed" };
      }
      const parsed = transport.parseMessage(event);
      // `argumentText` is the text without the app's own mention.
      const text = (payload.message.argumentText ?? parsed.text).trim();
      if (!text && parsed.attachments.length === 0) {
        return { kind: "ignore", reason: "empty message" };
      }
      const threadId = transport.encodeThreadId({
        spaceName: identity.channelId,
        ...(identity.threadId ? { threadName: identity.threadId } : {}),
        isDM: !identity.threadId,
      });

      return {
        kind: "message",
        message: toInboundMessage(
          payload.message,
          parsed,
          text,
          threadId,
          identity,
        ),
      };
    },

    actions: function (msg): ChannelActions {
      const source = toGoogleChatSource(msg.source);

      return {
        sendText: async function (text): Promise<void> {
          await transport.postMessage(source.threadId, { markdown: text });
        },
        // No typing indicator, and an app can react only with a user's credentials.
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

export function parseServiceAccountKey(
  json: string,
): ServiceAccountCredentials | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const key = SERVICE_ACCOUNT_KEY.safeParse(value);

  return key.success ? key.data : null;
}

function addOnEvent(event: GoogleChatWebhookEvent): GoogleChatEvent | null {
  if (event.chat?.messagePayload) {
    return event;
  }
  if (event.type !== "MESSAGE" || !event.message || !event.space) {
    return null;
  }

  return {
    chat: {
      ...(event.user ? { user: event.user } : {}),
      messagePayload: { message: event.message, space: event.space },
    },
  };
}

function googleChatIdentity(
  space: GoogleChatSpace,
  message: GoogleChatMessage,
): ChannelIdentity & { channelId: string } {
  const isDM = space.type === "DM" || space.spaceType === "DIRECT_MESSAGE";
  const threadName = isDM ? undefined : (message.thread?.name ?? message.name);

  return {
    channelId: space.name,
    ...(threadName ? { threadId: threadName } : {}),
    ...(message.sender?.name ? { userId: message.sender.name } : {}),
    ...(message.sender?.displayName
      ? { userName: message.sender.displayName }
      : {}),
  };
}

function googleChatTransport(
  options: GoogleChatChannelOptions,
): GoogleChatAdapter {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        options.credentials.client_email,
        options.credentials.private_key,
        options.endpointUrl,
        options.googleChatProjectNumber,
        options.userName,
        options.workspaceAddOnServiceAccountEmail,
      ]),
    )
    .digest("hex");
  const cached = transports.get(key);
  if (cached) {
    transports.delete(key);
    transports.set(key, cached);

    return cached;
  }
  const transport = new GoogleChatAdapter({
    credentials: options.credentials,
    disableSignatureVerification: false,
    endpointUrl: options.endpointUrl,
    googleChatProjectNumber: options.googleChatProjectNumber,
    logger: new ConsoleLogger("error").child("gchat"),
    userName: options.userName,
    workspaceAddOnServiceAccountEmail:
      options.workspaceAddOnServiceAccountEmail,
  });
  transports.set(key, transport);
  if (transports.size > TRANSPORT_CACHE_MAX) {
    const oldest = transports.keys().next().value;
    if (oldest !== undefined) {
      transports.delete(oldest);
    }
  }

  return transport;
}

function toGoogleChatSource(source: Record<string, unknown>): GoogleChatSource {
  if (
    typeof source.messageName !== "string" ||
    typeof source.spaceName !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error("Invalid Google Chat source payload");
  }

  return {
    messageName: source.messageName,
    spaceName: source.spaceName,
    threadId: source.threadId,
    ...(typeof source.threadName === "string"
      ? { threadName: source.threadName }
      : {}),
    ...(typeof source.userId === "string" ? { userId: source.userId } : {}),
    ...(typeof source.userName === "string"
      ? { userName: source.userName }
      : {}),
  };
}

function toInboundMessage(
  message: GoogleChatMessage,
  parsed: Message,
  text: string,
  threadId: string,
  identity: ChannelIdentity & { channelId: string },
): InboundMessage {
  const source: GoogleChatSource = {
    messageName: message.name,
    spaceName: identity.channelId,
    threadId: threadId,
    ...(identity.threadId ? { threadName: identity.threadId } : {}),
    ...(identity.userId ? { userId: identity.userId } : {}),
    ...(identity.userName ? { userName: identity.userName } : {}),
  };

  return {
    eventId: `${GCHAT_INTEGRATION_PREFIX}${message.name}`,
    conversationKey: `${GCHAT_INTEGRATION_PREFIX}${identity.threadId ?? identity.channelId}`,
    channelName: "gchat",
    content: text,
    ...(parsed.attachments.length > 0
      ? { attachments: parsed.attachments }
      : {}),
    identity: identity,
    source: { ...source },
  };
}
