/**
 * Linear channel adapter, for @-mentions in issue comments. The Chat SDK
 * adapter is the transport: it posts the reply under the comment thread and
 * reacts to the comment. The signature check is the Linear SDK's webhook
 * client, the same one the adapter runs. There is no streaming: every edit of
 * a Linear comment comes back as another webhook delivery.
 */

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
// A mention is stored as `@name` or as a link to the member's profile page.
const LINEAR_PROFILE_PATH = "/profiles/";

type LinearCommentWebhook = EntityWebhookPayloadWithCommentData;

type LinearIssueRef = NonNullable<LinearCommentWebhook["data"]["issue"]>;

export interface LinearChannelOptions {
  allowedChannelIds: ReadonlySet<string> | null;
  allowedUserIds: ReadonlySet<string> | null;
  apiKey: string;
  apiUrl?: string;
  /** Display name of the member the API key belongs to; `@userName` addresses the agent. */
  userName: string;
  webhookSecret: string;
}

export interface LinearSource {
  /** The comment that mentioned the agent, where the reaction goes. */
  commentId: string;
  issueId: string;
  /** `linear:{issueId}:c:{rootCommentId}`: the reply nests under the root comment. */
  threadId: string;
}

// The adapter's postMessage reads the bot's own id back into its result, and
// Chat fills that in on initialize(), which core never calls. This asks Linear
// for it once per request instead.
class BroodsLinearAdapter extends LinearAdapter {
  async loadIdentity(): Promise<void> {
    if (this.defaultBotUserId) return;
    const identity = await this.fetchClientIdentity(this.getClient());
    this.defaultBotUserId = identity.botUserId;
    this.defaultOrganizationId = identity.organizationId;
  }
}

/**
 * Builds the Linear adapter from one agent's `config.channels.linear`.
 * `integrations.ts` calls it per request, so it holds no state of its own.
 */
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

    canHandle: function (req) {
      return LINEAR_WEBHOOK_SIGNATURE_HEADER in req.headers;
    },

    // The SDK check also refuses a delivery whose signed webhookTimestamp is
    // more than a minute off, so a captured body cannot be replayed later.
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

    parse: function (req): ChannelParseResult {
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
      // Project updates and documents carry comments too; only issues reply.
      if (!comment.issueId || !issue || !user || comment.botActor) {
        return { kind: "ignore", reason: "not a member comment on an issue" };
      }
      if (isAuthor(user.url, options.userName)) {
        return { kind: "ignore", reason: "own comment" };
      }
      if (!mentions(comment.body, options.userName)) {
        return { kind: "ignore", reason: "not mentioned" };
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
        // Linear shows progress only inside agent sessions, which need an
        // OAuth app install; a comment thread has no typing indicator.
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

// The issue the comment is on, for the model. Issue text is written by anyone
// in the workspace, so it must not be able to close the block it is quoted in.
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

// A profile URL ends in the member's display name, the name userName holds.
function isAuthor(profileUrl: string, userName: string): boolean {
  const name = profileUrl.split(LINEAR_PROFILE_PATH)[1]?.split(/[/?#]/)[0];

  return name?.toLowerCase() === userName.toLowerCase();
}

// The mention gate in parse, the same plain match the GitHub channel uses.
function mentions(body: string, userName: string): boolean {
  const name = userName.toLowerCase();
  const text = body.toLowerCase();

  return (
    text.includes(`@${name}`) || text.includes(`${LINEAR_PROFILE_PATH}${name}`)
  );
}

// Reads the reply routing back from a stored message for actions().
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

// The signing time from the body. Linear also sends it as a header, but the
// signature covers only the body, so a header time would let a captured
// delivery pass the replay window again.
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
