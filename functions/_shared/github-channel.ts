/**
 * GitHub channel adapter.
 * Keep webhook verification, event parsing, and source mapping here.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelParseResult
} from "./channels.ts";
import { createGitHubActions } from "./github.ts";
import { logWarn } from "./log.ts";

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
  issueNumber?: number;
  pullNumber?: number;
  commentId?: number;
  target: "issue" | "issue_comment" | "pull_request" | "pull_request_review_comment";
}

export function createGitHubChannel(
  webhookSecret: string,
  appId: string,
  privateKey: string,
  allowedRepos: Set<string> | null,
): ChannelAdapter {
  return {
    name: "github",

    canHandle(req) {
      return "x-github-event" in req.headers;
    },

    authenticate(req) {
      const signature = req.headers["x-hub-signature-256"];
      if (!signature) {
        return false;
      }

      const expected = `sha256=${createHmac("sha256", webhookSecret).update(req.body).digest("hex")}`;
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);

      return actualBytes.length === expectedBytes.length
        && timingSafeEqual(actualBytes, expectedBytes);
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
          return parseIssuesEvent(payload, deliveryId, owner, repo, fullName);
        case "issue_comment":
          return parseIssueCommentEvent(payload, deliveryId, owner, repo, fullName);
        case "pull_request":
          return parsePullRequestEvent(payload, deliveryId, owner, repo, fullName);
        case "pull_request_review_comment":
          return parseReviewCommentEvent(payload, deliveryId, owner, repo, fullName);
        default:
          return { kind: "ignore" };
      }
    },

    actions(msg): ChannelActions {
      return createGitHubActions(appId, privateKey, toGitHubSource(msg.source));
    },
  };
}

function parseIssuesEvent(
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

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `gh:${deliveryId}`,
      conversationKey: `gh:${repoFullName}:issue:${issueNumber}`,
      channelName: "github",
      content: [{
        type: "text",
        text: formatTitleAndBody("Issue", payload.issue?.title, payload.issue?.body),
      }],
      source: {
        owner,
        repo,
        installationId,
        issueNumber,
        target: "issue",
      } satisfies GitHubSource,
    },
  };
}

function parseIssueCommentEvent(
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

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `gh:${deliveryId}`,
      conversationKey: `gh:${repoFullName}:${resource}:${issueNumber}`,
      channelName: "github",
      content: [{ type: "text", text: body }],
      source: {
        owner,
        repo,
        installationId,
        issueNumber,
        commentId,
        target: "issue_comment",
      } satisfies GitHubSource,
    },
  };
}

function parsePullRequestEvent(
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

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `gh:${deliveryId}`,
      conversationKey: `gh:${repoFullName}:pr:${pullNumber}`,
      channelName: "github",
      content: [{
        type: "text",
        text: formatTitleAndBody("Pull request", payload.pull_request?.title, payload.pull_request?.body),
      }],
      source: {
        owner,
        repo,
        installationId,
        issueNumber: pullNumber,
        pullNumber,
        target: "pull_request",
      } satisfies GitHubSource,
    },
  };
}

function parseReviewCommentEvent(
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

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: `gh:${deliveryId}`,
      conversationKey: `gh:${repoFullName}:pr:${pullNumber}`,
      channelName: "github",
      content: [{ type: "text", text: body }],
      source: {
        owner,
        repo,
        installationId,
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
    !isGitHubTarget(source.target)
  ) {
    throw new Error("Invalid GitHub source payload");
  }

  return {
    owner: source.owner,
    repo: source.repo,
    installationId: source.installationId,
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
