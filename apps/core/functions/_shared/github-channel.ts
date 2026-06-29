/**
 * GitHub channel adapter.
 * Keep Broods-specific event filtering/source mapping here; delegate GitHub auth and API calls to Chat SDK.
 */

import { GitHubAdapter, type GitHubThreadId } from "@chat-adapter/github";
import { ConsoleLogger } from "chat";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult
} from "./channels.ts";
import { logWarn } from "./log.ts";
import { GITHUB_INTEGRATION_PREFIX } from "./runtime-keys.ts";

interface GitHubRepository {
  full_name?: string;
  name?: string;
  owner?: { login?: string };
}

interface GitHubIssueRef {
  number?: number;
  title?: string;
  body?: string | null;
  pull_request?: object;
}

interface GitHubPullRequestRef {
  number?: number;
  title?: string;
  body?: string | null;
}

interface GitHubCommentRef {
  id?: number;
  in_reply_to_id?: number;
  body?: string | null;
  user?: {
    login?: string;
    type?: string;
  };
}

interface GitHubWebhookPayload {
  action?: string;
  repository?: GitHubRepository;
  issue?: GitHubIssueRef;
  pull_request?: GitHubPullRequestRef;
  comment?: GitHubCommentRef;
  installation?: { id?: number };
  sender?: {
    login?: string;
    type?: string;
  };
}

export interface GitHubSource {
  owner: string;
  repo: string;
  installationId: number;
  threadId: string;
  messageId?: string;
  issueNumber?: number;
  pullNumber?: number;
  commentId?: number;
  target: "issue" | "issue_comment" | "pull_request" | "pull_request_review_comment";
}

class BroodsGitHubAdapter extends GitHubAdapter {
  verifyWebhookSignature(body: string, signature: string | null | undefined): boolean {
    return this.verifySignature(body, signature ?? null);
  }
}

export function createGitHubChannel(
  webhookSecret: string,
  appId: string,
  privateKey: string,
  allowedRepos: Set<string> | null,
  apiUrl?: string,
): ChannelAdapter {
  const github = new BroodsGitHubAdapter({
    apiUrl,
    appId,
    privateKey: normalizePrivateKey(privateKey),
    webhookSecret,
    logger: new ConsoleLogger("error").child("github"),
  });

  return {
    name: "github",

    canHandle(req) {
      return "x-github-event" in req.headers;
    },

    authenticate(req) {
      return github.verifyWebhookSignature(req.body, req.headers["x-hub-signature-256"]);
    },

    parse(req): ChannelParseResult {
      const event = req.headers["x-github-event"];
      const deliveryId = req.headers["x-github-delivery"];
      const payload = JSON.parse(req.body) as GitHubWebhookPayload;

      if (event === "ping") {
        return {
          kind: "response",
          response: {
            statusCode: 200,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
            body: "ok",
          },
        };
      }

      const repository = payload.repository;
      const fullName = repository?.full_name;
      const owner = repository?.owner?.login;
      const repo = repository?.name;
      if (!event || !deliveryId || !fullName || !owner || !repo) {
        return { kind: "ignore" };
      }

      if (allowedRepos && !allowedRepos.has(fullName)) {
        logWarn("GitHub repository not in allow list", { repository: fullName });
        return { kind: "ignore" };
      }

      switch (event) {
        case "issues":
          return parseIssuesEvent(github, payload, deliveryId, owner, repo, fullName);
        case "issue_comment":
          return parseIssueCommentEvent(github, payload, deliveryId, owner, repo, fullName);
        case "pull_request":
          return parsePullRequestEvent(github, payload, deliveryId, owner, repo, fullName);
        case "pull_request_review_comment":
          return parseReviewCommentEvent(github, payload, deliveryId, owner, repo, fullName);
        default:
          return { kind: "ignore" };
      }
    },

    actions(msg): ChannelActions {
      return createGitHubActions(appId, privateKey, toGitHubSource(msg.source), apiUrl);
    },
  };
}

function parseIssuesEvent(
  github: GitHubAdapter,
  payload: GitHubWebhookPayload,
  deliveryId: string,
  owner: string,
  repo: string,
  repoFullName: string,
): ChannelParseResult {
  if (!isRelevantAction(payload.action)) {
    return { kind: "ignore" };
  }

  const issueNumber = payload.issue?.number;
  const installationId = payload.installation?.id;
  if (!issueNumber || !installationId) {
    return { kind: "ignore" };
  }
  const thread = { owner, repo, prNumber: issueNumber, type: "issue" } satisfies GitHubThreadId;
  const threadId = github.encodeThreadId(thread);

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${repoFullName}:issue:${issueNumber}`,
      channelName: "github",
      content: [{
        type: "text",
        text: formatTitleAndBody("Issue", payload.issue?.title, payload.issue?.body),
      }],
      source: {
        owner,
        repo,
        installationId,
        threadId,
        issueNumber,
        target: "issue",
      } satisfies GitHubSource,
    },
  };
}

function parseIssueCommentEvent(
  github: GitHubAdapter,
  payload: GitHubWebhookPayload,
  deliveryId: string,
  owner: string,
  repo: string,
  repoFullName: string,
): ChannelParseResult {
  if (!isRelevantAction(payload.action)) {
    return { kind: "ignore" };
  }

  if (isBotActor(payload.comment?.user?.type) || isBotActor(payload.sender?.type)) {
    return { kind: "ignore" };
  }

  const issueNumber = payload.issue?.number;
  const installationId = payload.installation?.id;
  const body = payload.comment?.body?.trim();
  const commentId = payload.comment?.id;
  if (!issueNumber || !installationId || !body || !commentId) {
    return { kind: "ignore" };
  }

  const resource = payload.issue?.pull_request ? "pr" : "issue";
  const thread = {
    owner,
    repo,
    prNumber: issueNumber,
    type: resource === "issue" ? "issue" : "pr",
  } satisfies GitHubThreadId;
  const threadId = github.encodeThreadId(thread);

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${repoFullName}:${resource}:${issueNumber}`,
      channelName: "github",
      content: [{ type: "text", text: body }],
      source: {
        owner,
        repo,
        installationId,
        threadId,
        messageId: String(commentId),
        issueNumber,
        commentId,
        target: "issue_comment",
      } satisfies GitHubSource,
    },
  };
}

function parsePullRequestEvent(
  github: GitHubAdapter,
  payload: GitHubWebhookPayload,
  deliveryId: string,
  owner: string,
  repo: string,
  repoFullName: string,
): ChannelParseResult {
  if (!isRelevantAction(payload.action)) {
    return { kind: "ignore" };
  }

  const pullNumber = payload.pull_request?.number;
  const installationId = payload.installation?.id;
  if (!pullNumber || !installationId) {
    return { kind: "ignore" };
  }
  const thread = { owner, repo, prNumber: pullNumber } satisfies GitHubThreadId;
  const threadId = github.encodeThreadId(thread);

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${repoFullName}:pr:${pullNumber}`,
      channelName: "github",
      content: [{
        type: "text",
        text: formatTitleAndBody("Pull request", payload.pull_request?.title, payload.pull_request?.body),
      }],
      source: {
        owner,
        repo,
        installationId,
        threadId,
        issueNumber: pullNumber,
        pullNumber,
        target: "pull_request",
      } satisfies GitHubSource,
    },
  };
}

function parseReviewCommentEvent(
  github: GitHubAdapter,
  payload: GitHubWebhookPayload,
  deliveryId: string,
  owner: string,
  repo: string,
  repoFullName: string,
): ChannelParseResult {
  if (!isRelevantAction(payload.action)) {
    return { kind: "ignore" };
  }

  if (isBotActor(payload.comment?.user?.type) || isBotActor(payload.sender?.type)) {
    return { kind: "ignore" };
  }

  const pullNumber = payload.pull_request?.number;
  const installationId = payload.installation?.id;
  const body = payload.comment?.body?.trim();
  const commentId = payload.comment?.id;
  if (!pullNumber || !installationId || !body || !commentId) {
    return { kind: "ignore" };
  }
  const rootCommentId = payload.comment?.in_reply_to_id ?? commentId;
  const thread = {
    owner,
    repo,
    prNumber: pullNumber,
    reviewCommentId: rootCommentId,
  } satisfies GitHubThreadId;
  const threadId = github.encodeThreadId(thread);

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${repoFullName}:pr:${pullNumber}`,
      channelName: "github",
      content: [{ type: "text", text: body }],
      source: {
        owner,
        repo,
        installationId,
        threadId,
        messageId: String(commentId),
        issueNumber: pullNumber,
        pullNumber,
        commentId,
        target: "pull_request_review_comment",
      } satisfies GitHubSource,
    },
  };
}

function toGitHubSource(source: Record<string, unknown>): GitHubSource {
  if (
    typeof source.owner !== "string" ||
    typeof source.repo !== "string" ||
    typeof source.installationId !== "number" ||
    typeof source.threadId !== "string" ||
    !isGitHubTarget(source.target)
  ) {
    throw new Error("Invalid GitHub source payload");
  }

  return {
    owner: source.owner,
    repo: source.repo,
    installationId: source.installationId,
    threadId: source.threadId,
    messageId: typeof source.messageId === "string" ? source.messageId : undefined,
    issueNumber: typeof source.issueNumber === "number" ? source.issueNumber : undefined,
    pullNumber: typeof source.pullNumber === "number" ? source.pullNumber : undefined,
    commentId: typeof source.commentId === "number" ? source.commentId : undefined,
    target: source.target,
  };
}

function isRelevantAction(action: string | undefined): boolean {
  return action === "opened" || action === "edited" || action === "reopened" || action === "created";
}

function isBotActor(type: string | undefined): boolean {
  return type === "Bot";
}

function isGitHubTarget(value: unknown): value is GitHubSource["target"] {
  return value === "issue"
    || value === "issue_comment"
    || value === "pull_request"
    || value === "pull_request_review_comment";
}

function formatTitleAndBody(prefix: string, title: string | undefined, body: string | null | undefined): string {
  const lines = [`${prefix}: ${title ?? "(untitled)"}`];
  if (body?.trim()) {
    lines.push("");
    lines.push(body.trim());
  }
  return lines.join("\n");
}

function createGitHubActions(
  appId: string,
  privateKey: string,
  source: GitHubSource,
  apiUrl?: string,
): ChannelActions {
  const github = new GitHubAdapter({
    apiUrl,
    appId,
    installationId: source.installationId,
    privateKey: normalizePrivateKey(privateKey),
    logger: new ConsoleLogger("error").child("github"),
    webhookSecret: "not-used-for-outbound-actions",
  });

  return {
    async sendText(text) {
      await github.postMessage(source.threadId, { markdown: text });
    },

    async sendTyping() {
      await github.startTyping(source.threadId);
    },

    async reactToMessage() {
      if (!source.messageId) {
        return;
      }
      await github.addReaction(source.threadId, source.messageId, "eyes");
    },

    stream: async (textStream, options) => {
      const result = await github.stream(source.threadId, textStream, options);
      return result.id;
    },
  };
}

function normalizePrivateKey(value: string): string {
  return value.includes("BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
}
