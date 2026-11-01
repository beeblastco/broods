import { LinearAdapter } from "@chat-adapter/linear";
import {
  type EntityWebhookPayloadWithCommentData,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LinearWebhookClient,
} from "@linear/sdk/webhooks";
import { ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult,
  ChannelRequest,
} from "./channels.ts";
import { isAllowedId, parseChannelWebhookBody } from "./channels.ts";
import { logWarn } from "./log.ts";
import { LINEAR_INTEGRATION_PREFIX } from "./runtime-keys.ts";

const LINEAR_CONTEXT_TAG = "linear_issue_context";
// Linear stores a mention as `@name` or as a link to the member's profile page.
const LINEAR_PROFILE_PATH = "/profiles/";

type LinearCommentWebhook = EntityWebhookPayloadWithCommentData;

type LinearIssueRef = NonNullable<LinearCommentWebhook["data"]["issue"]>;

export interface LinearChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiKey: string;
  apiUrl?: string;
  userName: string;
  webhookSecret: string;
}

export interface LinearSource {
  commentId: string;
  issueId: string;
  threadId: string;
}

// Chat sets the bot id on `initialize()`, which core never calls; parse and postMessage need it.
class BroodsLinearAdapter extends LinearAdapter {
  async loadIdentity(): Promise<string> {
    if (!this.defaultBotUserId) {
      const identity = await this.fetchClientIdentity(this.getClient());
      this.defaultBotUserId = identity.botUserId;
      this.defaultOrganizationId = identity.organizationId;
    }

    return this.defaultBotUserId;
  }
}

export function createLinearChannel(
  options: LinearChannelOptions,
): ChannelAdapter {
  const webhooks = new LinearWebhookClient(options.webhookSecret);
  const transport = new BroodsLinearAdapter({
    apiKey: options.apiKey,
    apiUrl: options.apiUrl,
    logger: new ConsoleLogger("error").child("linear"),
    userName: options.userName,
    webhookSecret: options.webhookSecret,
  });

  return {
    name: "linear",

    canHandle: function (req): boolean {
      return LINEAR_WEBHOOK_SIGNATURE_HEADER in req.headers;
    },

    authenticate: function (req): boolean {
      const signature = req.headers[LINEAR_WEBHOOK_SIGNATURE_HEADER];
      const timestamp = webhookTimestamp(req);
      if (!signature || timestamp === undefined) {
        return false;
      }
      try {
        return webhooks.verify(Buffer.from(req.body), signature, timestamp);
      } catch {
        logWarn("Linear webhook signature verification failed");

        return false;
      }
    },

    parse: async function (req): Promise<ChannelParseResult> {
      const body = parseChannelWebhookBody<LinearCommentWebhook>(
        "linear",
        req.body,
      );
      if (body.kind === "ignore") {
        return body;
      }
      const payload = body.payload;
      if (payload.type !== "Comment" || payload.action !== "create") {
        return { kind: "ignore", reason: "not a new comment" };
      }
      const comment = payload.data;
      const issue = comment.issue;
      const user = comment.user;
      if (!comment.issueId || !issue || !user || comment.botActor) {
        return { kind: "ignore", reason: "not a member comment on an issue" };
      }
      if (!mentions(comment.body, options.userName)) {
        return { kind: "ignore", reason: "not mentioned" };
      }
      // By id, not name: a wrong userName must not make the agent answer its own quoting reply.
      if (user.id === (await transport.loadIdentity())) {
        return { kind: "ignore", reason: "own comment" };
      }
      if (!isAllowedId(options.allowedChannelIds, issue.team.key)) {
        logWarn("Linear team not in allow list", { team: issue.team.key });

        return { kind: "ignore", reason: "not allowed" };
      }
      if (!isAllowedId(options.allowedUserIds, user.id)) {
        logWarn("Linear user not in allow list", { userId: user.id });

        return { kind: "ignore", reason: "not allowed" };
      }
      const threadId = transport.encodeThreadId({
        issueId: comment.issueId,
        commentId: comment.parentId ?? comment.id,
      });
      const source: LinearSource = {
        commentId: comment.id,
        issueId: comment.issueId,
        threadId: threadId,
      };
      const text = comment.body.trim();

      return {
        kind: "message",
        redelivers: true,
        ack: { statusCode: 200 },
        message: {
          eventId: `${LINEAR_INTEGRATION_PREFIX}${comment.id}`,
          conversationKey: threadId,
          channelName: "linear",
          content: text,
          events: [
            {
              role: "system",
              content: formatIssueContext(issue),
              persist: false,
            },
            { role: "user", content: [{ type: "text", text: text }] },
          ],
          identity: {
            workspaceRef: payload.organizationId,
            channelId: issue.team.key,
            threadId: issue.identifier,
            userId: user.id,
            userName: user.name,
          },
          source: { ...source },
        },
      };
    },

    actions: function (msg): ChannelActions {
      const source = toLinearSource(msg.source);

      return {
        sendText: async function (text): Promise<void> {
          await transport.loadIdentity();
          await transport.postMessage(source.threadId, { markdown: text });
        },
        // Only agent sessions (an OAuth app install) show progress; a comment thread cannot.
        sendTyping: async function (): Promise<void> {
          return;
        },
        supportsReactions: true,
        reactToMessage: async function (emoji): Promise<void> {
          await transport.addReaction(
            source.threadId,
            source.commentId,
            emoji ?? "eyes",
          );
        },
      };
    },
  };
}

// Anyone in the workspace writes issue text: it must not close the block it is quoted in.
function formatIssueContext(issue: LinearIssueRef): string {
  const quote = (value: string): string =>
    value.replaceAll(LINEAR_CONTEXT_TAG, "linear-issue-context");

  return [
    `<${LINEAR_CONTEXT_TAG}>`,
    `Issue: ${quote(issue.identifier)} ${quote(issue.title)}`,
    `URL: ${quote(issue.url)}`,
    `</${LINEAR_CONTEXT_TAG}>`,
  ].join("\n");
}

function mentions(body: string, userName: string): boolean {
  const name = RegExp.escape(userName);

  return new RegExp(`(?:@|${LINEAR_PROFILE_PATH})${name}(?![\\w-])`, "i").test(
    body,
  );
}

function toLinearSource(source: Record<string, unknown>): LinearSource {
  if (
    typeof source.commentId !== "string" ||
    typeof source.issueId !== "string" ||
    typeof source.threadId !== "string"
  ) {
    throw new Error("Invalid Linear source payload");
  }

  return {
    commentId: source.commentId,
    issueId: source.issueId,
    threadId: source.threadId,
  };
}

// From the body, not the header: only the body is signed, so a header time reopens replay.
function webhookTimestamp(req: ChannelRequest): number | undefined {
  const body = parseChannelWebhookBody<{ webhookTimestamp?: unknown }>(
    "linear",
    req.body,
  );

  return body.kind === "payload" &&
    typeof body.payload.webhookTimestamp === "number"
    ? body.payload.webhookTimestamp
    : undefined;
}
