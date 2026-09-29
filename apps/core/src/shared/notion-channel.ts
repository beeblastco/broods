/**
 * Notion channel adapter, for comment discussions on pages an integration is
 * connected to. The Chat SDK adapter is the transport: it checks the webhook
 * signature, reads the comment the event names, decides whether it addresses
 * the agent, and posts the reply into the same discussion once the turn ends.
 * Notion has no reactions and no typing indicator, so those actions do nothing.
 */

import {
  type NotionComment,
  NotionAdapter,
  type NotionMentionMode,
  type NotionWebhookEvent,
  verifyNotionSignature,
} from "@chat-adapter/notion";
import { ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
} from "./channels.ts";
import { isAllowedId, parseChannelWebhookBody } from "./channels.ts";
import { logWarn } from "./log.ts";
import { NOTION_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const NOTION_COMMENT_CREATED = "comment.created";
const NOTION_SIGNATURE_HEADER = "x-notion-signature";
// What a verification token looks like, so the one unsigned body core accepts
// cannot write arbitrary text into the agent's logs.
const NOTION_VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

// The one-time body Notion posts when a subscription is created, before any
// signing key exists.
interface NotionHandshake {
  verification_token: unknown;
}

type NotionDelivery = NotionWebhookEvent | NotionHandshake;

export interface NotionChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiBaseUrl?: string;
  keywords?: string[];
  mentionMode?: NotionMentionMode;
  token: string;
  userName?: string;
  /** Unset until the subscription handshake has been answered in Notion. */
  verificationToken?: string;
}

export interface NotionSource {
  /** The comment that addressed the agent. */
  commentId: string;
  pageId: string;
  /** `notion:{pageId}:{discussionId}`: the reply joins that discussion. */
  threadId: string;
}

// The SDK keeps comment lookup protected, so this subclass is an access shim
// and nothing else.
class BroodsNotionAdapter extends NotionAdapter {
  async commentPage(
    commentId: string,
    event: NotionWebhookEvent,
  ): Promise<{ comment: NotionComment; pageId: string } | null> {
    const comment = await this.retrieveComment(commentId);
    if (!comment) return null;

    return {
      comment: comment,
      pageId: await this.resolvePageId(comment, event),
    };
  }
}

/**
 * Builds the Notion adapter from one agent's `config.channels.notion`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
export function createNotionChannel(
  options: NotionChannelOptions,
): ChannelAdapter {
  const transport = new BroodsNotionAdapter({
    apiBaseUrl: options.apiBaseUrl,
    keywords: options.keywords,
    logger: new ConsoleLogger("error").child("notion"),
    mentionMode: options.mentionMode,
    token: options.token,
    userName: options.userName,
    verificationToken: options.verificationToken,
  });

  return {
    name: "notion",

    canHandle: function (req): boolean {
      return req.method === "POST";
    },

    // Every event is signed with the verification token. Before that token is
    // set, the only body a connection takes is Notion's unsigned handshake,
    // which never runs the agent.
    authenticate: function (req): boolean {
      if (!options.verificationToken) {
        return handshakeToken(req.body) !== undefined;
      }
      if (
        !verifyNotionSignature(
          req.body,
          req.headers[NOTION_SIGNATURE_HEADER] ?? null,
          options.verificationToken,
        )
      ) {
        logWarn("Notion webhook signature verification failed");

        return false;
      }

      return true;
    },

    parse: async function (req): Promise<ChannelParseResult> {
      const body = parseChannelWebhookBody<NotionDelivery>("notion", req.body);
      if (body.kind === "ignore") {
        return body;
      }
      const payload = body.payload;
      if ("verification_token" in payload) {
        return answerHandshake(req.body, options.verificationToken);
      }
      const commentId = payload.entity?.id;
      if (payload.type !== NOTION_COMMENT_CREATED || !commentId) {
        return { kind: "ignore", reason: `unsupported:${payload.type}` };
      }
      const found = await transport.commentPage(commentId, payload);
      if (!found) {
        return { kind: "ignore", reason: "comment gone" };
      }
      const parsed = transport.parseMessage({
        comment: found.comment,
        event: payload,
        pageId: found.pageId,
      });
      // A comment read back from the API rarely says who wrote it; the event
      // does, which is what keeps the agent's own replies from waking it.
      const userId = found.comment.created_by.id;
      if (
        parsed.author.isBot ||
        payload.authors?.some(
          (author) => author.id === userId && author.type !== "person",
        )
      ) {
        return { kind: "ignore", reason: "bot comment" };
      }
      if (!parsed.isMention) {
        return { kind: "ignore", reason: "not mentioned" };
      }
      // A page id is hyphenated in the API and bare in the page URL; either
      // form in the allow list names the page.
      if (
        !isAllowedId(options.allowedChannelIds, found.pageId) &&
        !isAllowedId(
          options.allowedChannelIds,
          found.pageId.replaceAll("-", ""),
        )
      ) {
        logWarn("Notion page not in allow list", { pageId: found.pageId });

        return { kind: "ignore", reason: "not allowed" };
      }
      if (!isAllowedId(options.allowedUserIds, userId)) {
        logWarn("Notion user not in allow list", { userId: userId });

        return { kind: "ignore", reason: "not allowed" };
      }
      const source: NotionSource = {
        commentId: found.comment.id,
        pageId: found.pageId,
        threadId: parsed.threadId,
      };
      const userName = found.comment.created_by.name;

      return {
        kind: "message",
        ack: { statusCode: 200 },
        message: {
          eventId: `${NOTION_INTEGRATION_PREFIX}${payload.id}`,
          conversationKey: parsed.threadId,
          channelName: "notion",
          content: parsed.text,
          ...(parsed.attachments.length > 0
            ? { attachments: parsed.attachments }
            : {}),
          identity: {
            workspaceRef: payload.workspace_id,
            channelId: found.pageId,
            threadId: found.comment.discussion_id,
            userId: userId,
            ...(userName ? { userName: userName } : {}),
          },
          source: { ...source },
        },
      };
    },

    actions: function (msg): ChannelActions {
      const source = toNotionSource(msg.source);

      return {
        sendText: async function (text): Promise<void> {
          await transport.postMessage(source.threadId, { markdown: text });
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

// Notion shows the verification token nowhere but in the request it sends, so
// the connection that is still waiting for one writes it to the agent's logs.
function answerHandshake(
  body: string,
  verificationToken: string | undefined,
): ChannelParseResult {
  const token = handshakeToken(body);
  if (verificationToken || !token) {
    return { kind: "ignore", reason: "unexpected handshake" };
  }
  logWarn(
    `Notion webhook verification token received. Paste it into the Verify dialog of the Notion subscription, then set it as verificationToken on this connection: ${token}`,
  );

  return {
    kind: "response",
    reason: "notion verification handshake",
    response: { statusCode: 200 },
  };
}

// The token in a handshake body, or undefined for any other body. authenticate
// and answerHandshake both read it.
function handshakeToken(body: string): string | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    "type" in payload ||
    !("verification_token" in payload) ||
    typeof payload.verification_token !== "string"
  ) {
    return undefined;
  }

  return NOTION_VERIFICATION_TOKEN_PATTERN.test(payload.verification_token)
    ? payload.verification_token
    : undefined;
}

// Reads the reply routing back from a stored message for actions().
function toNotionSource(source: Record<string, unknown>): NotionSource {
  if (
    typeof source.commentId !== "string" ||
    typeof source.pageId !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error("Invalid Notion source payload");
  }

  return {
    commentId: source.commentId,
    pageId: source.pageId,
    threadId: source.threadId,
  };
}
