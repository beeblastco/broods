/**
 * GitHub channel adapter.
 * Keep Broods-specific event filtering/source mapping here; delegate GitHub auth and API calls to Chat SDK.
 */

import { GitHubAdapter, type GitHubThreadId } from "@chat-adapter/github";
import { ConsoleLogger, fromFullStream } from "chat";
import { createSign } from "node:crypto";
import type {
  ChannelActions,
  ChannelAdapter,
  ChannelIngressEvent,
  ChannelParseResult,
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
  user?: { login?: string };
  state?: string;
}

interface GitHubPullRequestRef {
  number?: number;
  title?: string;
  body?: string | null;
  user?: { login?: string };
  state?: string;
}

interface GitHubCommentRef {
  id?: number;
  in_reply_to_id?: number;
  body?: string | null;
  created_at?: string;
  path?: string;
  line?: number | null;
  original_line?: number | null;
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
  assignee?: { login?: string; type?: string };
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

const GITHUB_API_VERSION = "2022-11-28";
const MAX_CONTEXT_COMMENTS = 50;
const MAX_CONTEXT_BODY_CHARS = 8000;
const MAX_CONTEXT_COMMENT_CHARS = 2000;

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
  userName?: string,
  botUserId?: number,
  options?: { triggerOnIssueOpen?: boolean; triggerOnPROpen?: boolean },
): ChannelAdapter {
  const github = new BroodsGitHubAdapter({
    apiUrl,
    appId,
    privateKey: normalizePrivateKey(privateKey),
    webhookSecret,
    userName,
    botUserId,
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

    parse(req): ChannelParseResult | Promise<ChannelParseResult> {
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

      if (allowedRepos && !allowedRepos.has("*") && !allowedRepos.has(fullName)) {
        logWarn("GitHub repository not in allow list", { repository: fullName });
        return { kind: "ignore" };
      }

      switch (event) {
        case "issues":
          return parseIssuesEvent(github, payload, deliveryId, owner, repo, fullName, options, userName);
        case "issue_comment":
          return parseIssueCommentEvent(github, payload, deliveryId, owner, repo, fullName, {
            apiUrl,
            appId,
            privateKey,
            botUserName: userName,
          });
        case "pull_request":
          return parsePullRequestEvent(github, payload, deliveryId, owner, repo, fullName, options, userName);
        case "pull_request_review_comment":
          return parseReviewCommentEvent(github, payload, deliveryId, owner, repo, fullName, {
            apiUrl,
            appId,
            privateKey,
            botUserName: userName,
          });
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
  options?: { triggerOnIssueOpen?: boolean },
  botUserName?: string,
): ChannelParseResult {
  const issueNumber = payload.issue?.number;
  const installationId = payload.installation?.id;
  if (!issueNumber || !installationId) {
    return { kind: "ignore" };
  }
  if (payload.action === "closed") {
    return {
      kind: "cleanup",
      ack: { statusCode: 200 },
      eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
      channelName: "github",
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${repoFullName}:issue:${issueNumber}`,
    };
  }
  if (payload.action === "assigned") {
    if (!isBotAssignee(payload, botUserName)) {
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
  if (!isRelevantAction(payload.action)) {
    return { kind: "ignore" };
  }
  if (options?.triggerOnIssueOpen === false) {
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
  options: { apiUrl?: string; appId: string; privateKey: string; botUserName?: string },
): Promise<ChannelParseResult> | ChannelParseResult {
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

  if (options.botUserName && !body.toLowerCase().includes(`@${options.botUserName.toLowerCase()}`)) {
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

  return buildCommentMessage({
    payload,
    options,
    resource,
    owner,
    repo,
    repoFullName,
    installationId,
    issueNumber,
    commentId,
    threadId,
    eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
    body,
    target: "issue_comment",
  });
}

async function buildCommentMessage(options: {
  payload: GitHubWebhookPayload;
  options: { apiUrl?: string; appId: string; privateKey: string; botUserName?: string };
  resource: "issue" | "pr";
  owner: string;
  repo: string;
  repoFullName: string;
  installationId: number;
  issueNumber: number;
  commentId: number;
  threadId: string;
  eventId: string;
  body: string;
  target: "issue_comment";
}): Promise<ChannelParseResult> {
  const contextEvent = await hydrateGitHubThreadContext({
    apiUrl: options.options.apiUrl,
    appId: options.options.appId,
    privateKey: options.options.privateKey,
    owner: options.owner,
    repo: options.repo,
    installationId: options.installationId,
    resource: options.resource,
    number: options.issueNumber,
    currentCommentId: options.commentId,
    currentCommentCreatedAt: options.payload.comment?.created_at,
  });
  const events: ChannelIngressEvent[] = [
    ...(contextEvent ? [contextEvent] : []),
    { role: "user", content: [{ type: "text", text: options.body }] },
  ];

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: options.eventId,
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${options.repoFullName}:${options.resource}:${options.issueNumber}`,
      channelName: "github",
      content: [{ type: "text", text: options.body }],
      events,
      source: {
        owner: options.owner,
        repo: options.repo,
        installationId: options.installationId,
        threadId: options.threadId,
        messageId: String(options.commentId),
        issueNumber: options.issueNumber,
        commentId: options.commentId,
        target: options.target,
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
  options?: { triggerOnPROpen?: boolean },
  botUserName?: string,
): ChannelParseResult {
  const pullNumber = payload.pull_request?.number;
  const installationId = payload.installation?.id;
  if (!pullNumber || !installationId) {
    return { kind: "ignore" };
  }
  if (payload.action === "closed") {
    return {
      kind: "cleanup",
      ack: { statusCode: 200 },
      eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
      channelName: "github",
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${repoFullName}:pr:${pullNumber}`,
    };
  }
  if (payload.action === "assigned") {
    if (!isBotAssignee(payload, botUserName)) {
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
  if (!isRelevantAction(payload.action)) {
    return { kind: "ignore" };
  }
  if (options?.triggerOnPROpen === false) {
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
  options: { apiUrl?: string; appId: string; privateKey: string; botUserName?: string },
): Promise<ChannelParseResult> | ChannelParseResult {
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

  if (options.botUserName && !body.toLowerCase().includes(`@${options.botUserName.toLowerCase()}`)) {
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

  return buildReviewCommentMessage({
    payload,
    options,
    owner,
    repo,
    repoFullName,
    installationId,
    pullNumber,
    commentId,
    threadId,
    eventId: `${GITHUB_INTEGRATION_PREFIX}${deliveryId}`,
    body,
  });
}

async function buildReviewCommentMessage(options: {
  payload: GitHubWebhookPayload;
  options: { apiUrl?: string; appId: string; privateKey: string; botUserName?: string };
  owner: string;
  repo: string;
  repoFullName: string;
  installationId: number;
  pullNumber: number;
  commentId: number;
  threadId: string;
  eventId: string;
  body: string;
}): Promise<ChannelParseResult> {
  const contextEvent = await hydrateGitHubThreadContext({
    apiUrl: options.options.apiUrl,
    appId: options.options.appId,
    privateKey: options.options.privateKey,
    owner: options.owner,
    repo: options.repo,
    installationId: options.installationId,
    resource: "pr",
    number: options.pullNumber,
    currentCommentId: options.commentId,
    currentCommentCreatedAt: options.payload.comment?.created_at,
    includeReviewComments: true,
  });
  const events: ChannelIngressEvent[] = [
    ...(contextEvent ? [contextEvent] : []),
    { role: "user", content: [{ type: "text", text: options.body }] },
  ];

  return {
    kind: "message",
    ack: { statusCode: 200 },
    message: {
      eventId: options.eventId,
      conversationKey: `${GITHUB_INTEGRATION_PREFIX}${options.repoFullName}:pr:${options.pullNumber}`,
      channelName: "github",
      content: [{ type: "text", text: options.body }],
      events,
      source: {
        owner: options.owner,
        repo: options.repo,
        installationId: options.installationId,
        threadId: options.threadId,
        messageId: String(options.commentId),
        issueNumber: options.pullNumber,
        pullNumber: options.pullNumber,
        commentId: options.commentId,
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

function isBotAssignee(payload: GitHubWebhookPayload, botUserName: string | undefined): boolean {
  if (!botUserName) return false;
  const assignee = payload.assignee;
  if (!assignee?.login) return false;
  if (isBotActor(assignee.type)) return false;
  return assignee.login.toLowerCase() === botUserName.toLowerCase();
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

async function hydrateGitHubThreadContext(options: {
  apiUrl?: string;
  appId: string;
  privateKey: string;
  owner: string;
  repo: string;
  installationId: number;
  resource: "issue" | "pr";
  number: number;
  currentCommentId: number;
  currentCommentCreatedAt?: string;
  includeReviewComments?: boolean;
}): Promise<ChannelIngressEvent | null> {
  try {
    const client = await createGitHubRestClient(options);
    const thread = options.resource === "issue"
      ? await client.get<GitHubIssueRef>(`/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/issues/${options.number}`)
      : await client.get<GitHubPullRequestRef>(`/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/pulls/${options.number}`);
    const issueComments = await client.get<GitHubCommentRef[]>(
      `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/issues/${options.number}/comments?per_page=100`,
    );
    const reviewComments = options.includeReviewComments
      ? await client.get<GitHubCommentRef[]>(
        `/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/pulls/${options.number}/comments?per_page=100`,
      )
      : [];

    const content = formatGitHubThreadContext({
      owner: options.owner,
      repo: options.repo,
      resource: options.resource,
      number: options.number,
      thread,
      issueComments,
      reviewComments,
      currentCommentId: options.currentCommentId,
      currentCommentCreatedAt: options.currentCommentCreatedAt,
    });
    return content
      ? { role: "system", content, persist: false }
      : null;
  } catch (error) {
    logWarn("GitHub thread context hydration failed; continuing with current comment only", {
      owner: options.owner,
      repo: options.repo,
      resource: options.resource,
      number: options.number,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function createGitHubRestClient(options: {
  apiUrl?: string;
  appId: string;
  privateKey: string;
  installationId: number;
}) {
  const baseApiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  const appJwt = createGitHubAppJwt(options.appId, options.privateKey);
  const tokenResponse = await fetch(`${baseApiUrl}/app/installations/${options.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
  if (!tokenResponse.ok) {
    throw new Error(`installation token request failed (${tokenResponse.status})`);
  }
  const tokenJson = await tokenResponse.json() as { token?: unknown };
  if (typeof tokenJson.token !== "string" || tokenJson.token.length === 0) {
    throw new Error("installation token response did not include a token");
  }

  return {
    async get<T>(path: string): Promise<T> {
      const response = await fetch(`${baseApiUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokenJson.token}`,
          "X-GitHub-Api-Version": GITHUB_API_VERSION,
        },
      });
      if (!response.ok) {
        throw new Error(`GitHub GET ${path} failed (${response.status})`);
      }
      return await response.json() as T;
    },
  };
}

function formatGitHubThreadContext(options: {
  owner: string;
  repo: string;
  resource: "issue" | "pr";
  number: number;
  thread: GitHubIssueRef | GitHubPullRequestRef;
  issueComments: GitHubCommentRef[];
  reviewComments: GitHubCommentRef[];
  currentCommentId: number;
  currentCommentCreatedAt?: string;
}): string {
  const title = safeText(options.thread.title) || "(untitled)";
  const body = truncateText(safeText(options.thread.body), MAX_CONTEXT_BODY_CHARS);
  const comments = [
    ...options.issueComments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.created_at,
      author: comment.user?.login,
      label: "comment",
    })),
    ...options.reviewComments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.created_at,
      author: comment.user?.login,
      label: formatReviewCommentLabel(comment),
    })),
  ]
    .filter((comment) => isPriorGitHubComment(comment, options.currentCommentId, options.currentCommentCreatedAt))
    .sort((left, right) => (left.createdAt ?? "").localeCompare(right.createdAt ?? ""))
    .slice(-MAX_CONTEXT_COMMENTS);

  const lines = [
    "<github_thread_context>",
    `Repository: ${options.owner}/${options.repo}`,
    `Thread: ${options.resource === "issue" ? "Issue" : "Pull request"} #${options.number}`,
    `Title: ${title}`,
    `State: ${safeText(options.thread.state) || "unknown"}`,
    `Author: ${safeText(options.thread.user?.login) || "unknown"}`,
    "",
    "Body:",
    body || "(empty)",
  ];

  if (comments.length > 0) {
    lines.push("", `Prior comments (${comments.length}${comments.length === MAX_CONTEXT_COMMENTS ? " most recent" : ""}):`);
    for (const comment of comments) {
      lines.push(
        "",
        `- ${comment.label} by ${safeText(comment.author) || "unknown"} at ${safeText(comment.createdAt) || "unknown time"}:`,
        truncateText(safeText(comment.body), MAX_CONTEXT_COMMENT_CHARS) || "(empty)",
      );
    }
  } else {
    lines.push("", "Prior comments: (none)");
  }

  lines.push("</github_thread_context>");
  return lines.join("\n");
}

function isPriorGitHubComment(
  comment: { id?: number; createdAt?: string },
  currentCommentId: number,
  currentCommentCreatedAt?: string,
): boolean {
  if (comment.id === currentCommentId) {
    return false;
  }
  if (currentCommentCreatedAt && comment.createdAt) {
    return comment.createdAt < currentCommentCreatedAt;
  }
  return true;
}

function formatReviewCommentLabel(comment: GitHubCommentRef): string {
  const path = safeText(comment.path);
  const line = comment.line ?? comment.original_line;
  return path
    ? `review comment on ${path}${line ? `:${line}` : ""}`
    : "review comment";
}

function createGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(JSON.stringify({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .end()
    .sign(normalizePrivateKey(privateKey));
  return `${unsigned}.${base64UrlEncode(signature)}`;
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars).trimEnd()}\n...(truncated)` : value;
}

function safeText(value: string | null | undefined): string {
  return value?.trim() ?? "";
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
      const result = await github.stream(source.threadId, fromFullStream(textStream), options);
      return result.id;
    },
  };
}

function normalizePrivateKey(value: string): string {
  return value.includes("BEGIN") ? value : Buffer.from(value, "base64").toString("utf8");
}
