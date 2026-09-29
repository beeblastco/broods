/**
 * X channel adapter, for direct messages through the X Activity API. The Chat
 * SDK adapter is the transport: it answers X's CRC challenge, checks the
 * signature on each delivery and sends the reply. Public mentions are not
 * handled here, so an agent only ever answers in a DM.
 */

import {
  extractDmEvents,
  XAdapter,
  type XActivityEnvelope,
  type XActivityEvent,
} from "@chat-adapter/x";
import { ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
  ChannelRequest,
} from "./channels.ts";
import { isAllowedId, parseChannelWebhookBody } from "./channels.ts";
import { logWarn } from "./log.ts";
import { X_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const X_SIGNATURE_HEADER = "x-twitter-webhooks-signature";
const X_CRC_PARAM = "crc_token";
const X_DM_RECEIVED = "dm.received";

type XDm = ReturnType<typeof extractDmEvents>[number];

export interface XChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiBaseUrl?: string;
  consumerSecret: string;
  userAccessToken: string;
  userId: string;
  userName?: string;
}

export interface XSource {
  dmEventId: string;
  senderId: string;
  threadId: string;
  userName?: string;
}

// The SDK keeps the CRC answer and the signature check protected, so this
// subclass is an access shim and nothing else. The CRC answer constrains the
// token before signing it, which keeps it from being a signing oracle.
class BroodsXAdapter extends XAdapter {
  answerCrc(request: Request): Response {
    return this.handleCrcChallenge(request);
  }

  hasValidSignature(request: Request, body: string): boolean {
    return this.verifySignature(request, body);
  }
}

/**
 * Builds the X adapter from one agent's `config.channels.x`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
export function createXChannel(options: XChannelOptions): ChannelAdapter {
  const transport = new BroodsXAdapter({
    apiBaseUrl: options.apiBaseUrl,
    consumerSecret: options.consumerSecret,
    logger: new ConsoleLogger("error").child("x"),
    userAccessToken: options.userAccessToken,
    userId: options.userId,
    userName: options.userName,
  });

  return {
    name: "x",

    canHandle: function (req) {
      if (req.method === "GET") {
        return new URLSearchParams(req.rawQueryString).has(X_CRC_PARAM);
      }

      return X_SIGNATURE_HEADER in req.headers;
    },

    // X signs deliveries but not the CRC challenge: answering it is the proof,
    // since only the consumer secret produces the right token.
    authenticate: function (req) {
      if (req.method === "GET") {
        return true;
      }
      if (!transport.hasValidSignature(toRequest(req), req.body)) {
        logWarn("X webhook signature verification failed");

        return false;
      }

      return true;
    },

    parse: async function (req): Promise<ChannelParseResult> {
      if (req.method === "GET") {
        const answer = transport.answerCrc(toRequest(req));

        return {
          kind: "response",
          reason: "crc challenge",
          response: {
            statusCode: answer.status,
            headers: {
              "content-type":
                answer.headers.get("content-type") ?? "text/plain",
            },
            body: await answer.text(),
          },
        };
      }
      const body = parseChannelWebhookBody<XActivityEnvelope>("x", req.body);
      if (body.kind === "ignore") {
        return body;
      }
      const dm = findInboundDm(body.payload, options.userId);
      if (!dm?.dmEvent.sender_id || !dm.dmEvent.text) {
        return { kind: "ignore", reason: "no dm for this account" };
      }
      const senderId = dm.dmEvent.sender_id;
      if (
        !isAllowedId(options.allowedChannelIds, senderId) ||
        !isAllowedId(options.allowedUserIds, senderId)
      ) {
        logWarn("X sender not in allow list", { userId: senderId });

        return { kind: "ignore", reason: "not allowed" };
      }
      const parsed = transport.parseMessage({
        dmEvent: dm.dmEvent,
        kind: "dm",
        sender: dm.sender,
      });
      const userName = dm.sender?.username;
      const source: XSource = {
        dmEventId: dm.dmEvent.id,
        senderId: senderId,
        threadId: parsed.threadId,
        ...(userName ? { userName: userName } : {}),
      };

      return {
        kind: "message",
        message: {
          eventId: `${X_INTEGRATION_PREFIX}${dm.dmEvent.id}`,
          conversationKey: parsed.threadId,
          channelName: "x",
          content: parsed.text,
          identity: {
            channelId: senderId,
            userId: senderId,
            ...(userName ? { userName: userName } : {}),
          },
          source: { ...source },
        },
      };
    },

    actions: function (msg): ChannelActions {
      const source = toXSource(msg.source);

      return {
        sendText: async function (text): Promise<void> {
          await transport.postMessage(source.threadId, { markdown: text });
        },
        // X has no typing indicator, and a like only goes on a public post.
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

// The first DM someone else sent this account. One X app webhook carries every
// account that authorized the app, and the bot's own replies echo back as
// dm.received too, so both are filtered out.
function findInboundDm(
  envelope: XActivityEnvelope,
  userId: string,
): XDm | undefined {
  const events: XActivityEvent[] = Array.isArray(envelope.data)
    ? envelope.data
    : envelope.data
      ? [envelope.data]
      : [];
  const dms = events
    .filter(
      (event) =>
        event.event_type === X_DM_RECEIVED &&
        (event.filter?.user_id === undefined ||
          event.filter.user_id === userId),
    )
    .flatMap((event) => extractDmEvents(event.payload, event.includes?.users))
    .filter((dm) => dm.dmEvent.sender_id !== userId);
  if (dms.length > 1) {
    logWarn("X webhook carried more than one DM", { count: dms.length });
  }

  return dms[0];
}

// The SDK reads the signature header and the CRC query from a web Request.
function toRequest(req: ChannelRequest): Request {
  return new Request(
    `https://core.invalid${req.rawPath}${req.rawQueryString ? `?${req.rawQueryString}` : ""}`,
    { method: req.method, headers: req.headers },
  );
}

function toXSource(source: Record<string, unknown>): XSource {
  if (
    typeof source.dmEventId !== "string" ||
    typeof source.senderId !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error("Invalid X source payload");
  }

  return {
    dmEventId: source.dmEventId,
    senderId: source.senderId,
    threadId: source.threadId,
    ...(typeof source.userName === "string"
      ? { userName: source.userName }
      : {}),
  };
}
