/**
 * GitHub channel adapter tests.
 * Cover webhook auth, allow-list handling, and issue/comment normalization here.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createGitHubChannel } from "../src/shared/github-channel.ts";

describe("github channel adapter", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("authenticates valid webhook signatures and rejects mismatches", () => {
    const body = JSON.stringify({
      action: "opened",
      repository: createRepository(),
      issue: { number: 1, title: "Issue title", body: "Issue body" },
      installation: { id: 99 },
    });

    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
    );

    expect(
      adapter.authenticate(
        createRequest(body, {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": sign(body),
        }),
      ),
    ).toBe(true);

    expect(
      adapter.authenticate(
        createRequest(body, {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-1",
          "x-hub-signature-256": "sha256=bad",
        }),
      ),
    ).toBe(false);
  });

  it("responds to ping events", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
    );

    const parsed = await adapter.parse(
      createRequest(JSON.stringify({ zen: "pong" }), {
        "x-github-event": "ping",
      }),
    );

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected GitHub ping to return a response");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toBe("ok");
  });

  it("ignores repositories outside the allow list", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      new Set(["owner/allowed"]),
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "opened",
          repository: createRepository(),
          issue: { number: 1, title: "Issue title", body: "Issue body" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-2",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("allows all repos when allowedRepos contains '*'", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      new Set(["*"]),
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "opened",
          repository: createRepository(),
          issue: { number: 1, title: "Issue title", body: "Issue body" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-wildcard",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
  });

  it("normalizes issue events into issue conversation keys", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "opened",
          repository: createRepository(),
          issue: { number: 7, title: "Bug", body: "Details" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-3",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected GitHub issue event to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200 });
    expect(parsed.message.eventId).toBe("gh:delivery-3");
    expect(parsed.message.conversationKey).toBe("gh:owner/repo:issue:7");
    expect(parsed.message.content).toEqual([
      { type: "text", text: "Issue: Bug\n\nDetails" },
    ]);
    expect(parsed.message.source).toEqual({
      owner: "owner",
      repo: "repo",
      installationId: 99,
      threadId: "github:owner/repo:issue:7",
      issueNumber: 7,
      target: "issue",
    });
  });

  it("routes pull request issue comments into pr conversation keys", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          issue: { number: 12, pull_request: {} },
          comment: {
            id: 55,
            body: "Looks good",
            user: { login: "alice", type: "User" },
          },
          installation: { id: 99 },
          sender: { login: "alice", type: "User" },
        }),
        {
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-4",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected GitHub PR comment to be accepted");
    }

    expect(parsed.message.conversationKey).toBe("gh:owner/repo:pr:12");
    expect(parsed.message.content).toEqual([
      { type: "text", text: "Looks good" },
    ]);
    expect(parsed.message.source).toEqual({
      owner: "owner",
      repo: "repo",
      installationId: 99,
      threadId: "github:owner/repo:12",
      messageId: "55",
      issueNumber: 12,
      commentId: 55,
      target: "issue_comment",
    });
  });

  it("normalizes closed issue and pull request events into cleanup results", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
    );

    const issue = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "closed",
          repository: createRepository(),
          issue: { number: 7, title: "Bug", body: "Details" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-closed-issue",
        },
      ),
    );
    expect(issue).toEqual({
      kind: "cleanup",
      ack: { statusCode: 200 },
      eventId: "gh:delivery-closed-issue",
      channelName: "github",
      conversationKey: "gh:owner/repo:issue:7",
    });

    const pullRequest = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "closed",
          repository: createRepository(),
          pull_request: { number: 12, title: "PR", body: "Details" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-closed-pr",
        },
      ),
    );
    expect(pullRequest).toEqual({
      kind: "cleanup",
      ack: { statusCode: 200 },
      eventId: "gh:delivery-closed-pr",
      channelName: "github",
      conversationKey: "gh:owner/repo:pr:12",
    });
  });

  it("ignores issue comments from bot actors", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          issue: { number: 12 },
          comment: {
            id: 55,
            body: "Automated note",
            user: { login: "bot", type: "Bot" },
          },
          installation: { id: 99 },
          sender: { login: "bot", type: "Bot" },
        }),
        {
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-5",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("ignores issue comments without @-mention when userName is configured", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          issue: { number: 12 },
          comment: {
            id: 55,
            body: "This is a regular comment",
            user: { login: "alice", type: "User" },
          },
          installation: { id: 99 },
          sender: { login: "alice", type: "User" },
        }),
        {
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-6",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("accepts issue comments with @-mention when userName is configured", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          issue: { number: 12 },
          comment: {
            id: 55,
            body: "@my-bot please help with this issue",
            user: { login: "alice", type: "User" },
          },
          installation: { id: 99 },
          sender: { login: "alice", type: "User" },
        }),
        {
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-7",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
  });

  it("hydrates issue title, body, and prior comments for tagged issue comments", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      jsonBody: unknown;
    }> = [];
    globalThis.fetch = createFetchMock(calls, [
      jsonResponse(201, { token: "installation-token" }),
      jsonResponse(200, {
        number: 12,
        title: "Existing outage",
        body: "Original issue body",
        state: "open",
        user: { login: "reporter" },
      }),
      jsonResponse(200, [
        {
          id: 50,
          body: "First detail before the tag",
          created_at: "2026-06-01T10:00:00Z",
          user: { login: "alice" },
        },
        {
          id: 55,
          body: "@my-bot please summarize",
          created_at: "2026-06-01T10:05:00Z",
          user: { login: "bob" },
        },
        {
          id: 56,
          body: "Comment after current webhook",
          created_at: "2026-06-01T10:06:00Z",
          user: { login: "carol" },
        },
      ]),
    ]);
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      testPrivateKey(),
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          issue: { number: 12 },
          comment: {
            id: 55,
            body: "@my-bot please summarize",
            created_at: "2026-06-01T10:05:00Z",
            user: { login: "bob", type: "User" },
          },
          installation: { id: 99 },
          sender: { login: "bob", type: "User" },
        }),
        {
          "x-github-event": "issue_comment",
          "x-github-delivery": "delivery-hydrate",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected GitHub issue comment to be accepted");
    }

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/app/installations/99/access_tokens",
      "https://api.github.com/repos/owner/repo/issues/12",
      "https://api.github.com/repos/owner/repo/issues/12/comments?per_page=100",
    ]);
    expect(parsed.message.events).toHaveLength(2);
    expect(parsed.message.events?.[0]?.role).toBe("system");
    const context = String(parsed.message.events?.[0]?.content ?? "");
    expect(context).toContain("<github_thread_context>");
    expect(context).toContain("Title: Existing outage");
    expect(context).toContain("Original issue body");
    expect(context).toContain("First detail before the tag");
    expect(context).not.toContain("@my-bot please summarize");
    expect(context).not.toContain("Comment after current webhook");
    expect(parsed.message.events?.[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "@my-bot please summarize" }],
    });
  });

  it("hydrates pull request body, issue comments, and review comments for tagged review comments", async () => {
    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      jsonBody: unknown;
    }> = [];
    globalThis.fetch = createFetchMock(calls, [
      jsonResponse(201, { token: "installation-token" }),
      jsonResponse(200, {
        number: 10,
        title: "Improve retries",
        body: "Pull request body",
        state: "open",
        user: { login: "reporter" },
      }),
      jsonResponse(200, [
        {
          id: 70,
          body: "PR conversation note",
          created_at: "2026-06-01T09:00:00Z",
          user: { login: "alice" },
        },
      ]),
      jsonResponse(200, [
        {
          id: 59,
          body: "Earlier line note",
          path: "src/retry.ts",
          line: 14,
          created_at: "2026-06-01T09:30:00Z",
          user: { login: "reviewer" },
        },
        {
          id: 60,
          body: "@my-bot can you review this?",
          path: "src/retry.ts",
          line: 18,
          created_at: "2026-06-01T10:00:00Z",
          user: { login: "bob" },
        },
      ]),
    ]);
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      testPrivateKey(),
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          pull_request: { number: 10 },
          comment: {
            id: 60,
            body: "@my-bot can you review this?",
            path: "src/retry.ts",
            line: 18,
            created_at: "2026-06-01T10:00:00Z",
            user: { login: "bob", type: "User" },
          },
          installation: { id: 99 },
          sender: { login: "bob", type: "User" },
        }),
        {
          "x-github-event": "pull_request_review_comment",
          "x-github-delivery": "delivery-pr-hydrate",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected GitHub review comment to be accepted");
    }

    expect(calls.map((call) => call.url)).toEqual([
      "https://api.github.com/app/installations/99/access_tokens",
      "https://api.github.com/repos/owner/repo/pulls/10",
      "https://api.github.com/repos/owner/repo/issues/10/comments?per_page=100",
      "https://api.github.com/repos/owner/repo/pulls/10/comments?per_page=100",
    ]);
    const context = String(parsed.message.events?.[0]?.content ?? "");
    expect(context).toContain("Thread: Pull request #10");
    expect(context).toContain("PR conversation note");
    expect(context).toContain("review comment on src/retry.ts:14");
    expect(context).toContain("Earlier line note");
    expect(context).not.toContain("@my-bot can you review this?");
  });

  it("accepts review comments with @-mention when userName is configured", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          pull_request: { number: 10 },
          comment: {
            id: 60,
            body: "@my-bot can you review this?",
            user: { login: "bob", type: "User" },
          },
          installation: { id: 99 },
          sender: { login: "bob", type: "User" },
        }),
        {
          "x-github-event": "pull_request_review_comment",
          "x-github-delivery": "delivery-8",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
  });

  it("ignores review comments without @-mention when userName is configured", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "created",
          repository: createRepository(),
          pull_request: { number: 10 },
          comment: {
            id: 60,
            body: "Looks good to me",
            user: { login: "bob", type: "User" },
          },
          installation: { id: 99 },
          sender: { login: "bob", type: "User" },
        }),
        {
          "x-github-event": "pull_request_review_comment",
          "x-github-delivery": "delivery-9",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("triggers on issue assigned to bot user", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          issue: { number: 5, title: "Feature request", body: "Add dark mode" },
          assignee: { login: "my-bot", type: "User" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-assigned-issue",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.conversationKey).toBe("gh:owner/repo:issue:5");
    expect(parsed.message.source).toEqual(
      expect.objectContaining({ target: "issue", issueNumber: 5 }),
    );
  });

  it("ignores issue assigned to non-bot user", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          issue: { number: 5, title: "Feature request", body: "Add dark mode" },
          assignee: { login: "alice", type: "User" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-assigned-other",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("ignores issue assigned when userName is not configured", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          issue: { number: 5, title: "Feature request", body: "Add dark mode" },
          assignee: { login: "my-bot", type: "User" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-assigned-no-username",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("ignores issue assigned by a bot actor", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          issue: { number: 5, title: "Feature request", body: "Add dark mode" },
          assignee: { login: "my-bot", type: "Bot" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-assigned-bot-type",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("triggers on PR assigned to bot user", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          pull_request: { number: 8, title: "Fix bug", body: "Regression fix" },
          assignee: { login: "my-bot", type: "User" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-assigned-pr",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.conversationKey).toBe("gh:owner/repo:pr:8");
    expect(parsed.message.source).toEqual(
      expect.objectContaining({ target: "pull_request", pullNumber: 8 }),
    );
  });

  it("ignores PR assigned to non-bot user", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          pull_request: { number: 8, title: "Fix bug", body: "Regression fix" },
          assignee: { login: "alice", type: "User" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-assigned-pr-other",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("ignores opened issue when triggerOnIssueOpen is false", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      undefined,
      undefined,
      { triggerOnIssueOpen: false },
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "opened",
          repository: createRepository(),
          issue: { number: 10, title: "New issue", body: "Body" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-trigger-off",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("ignores opened PR when triggerOnPROpen is false", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      undefined,
      undefined,
      { triggerOnPROpen: false },
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "opened",
          repository: createRepository(),
          pull_request: { number: 15, title: "New PR", body: "Body" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-trigger-pr-off",
        },
      ),
    );

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("triggers on assigned issue even when triggerOnIssueOpen is false", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
      undefined,
      { triggerOnIssueOpen: false },
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          issue: { number: 5, title: "Feature request", body: "Add dark mode" },
          assignee: { login: "my-bot", type: "User" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-assigned-despite-flag",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
  });

  it("triggers on assigned PR even when triggerOnPROpen is false", async () => {
    const adapter = createGitHubChannel(
      "webhook-secret",
      "app-id",
      "private-key",
      null,
      undefined,
      "my-bot",
      undefined,
      { triggerOnPROpen: false },
    );

    const parsed = await adapter.parse(
      createRequest(
        JSON.stringify({
          action: "assigned",
          repository: createRepository(),
          pull_request: { number: 8, title: "Fix bug", body: "Regression fix" },
          assignee: { login: "my-bot", type: "User" },
          installation: { id: 99 },
        }),
        {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-assigned-pr-despite-flag",
        },
      ),
    );

    expect(parsed.kind).toBe("message");
  });
});

function createFetchMock(
  calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
    jsonBody: unknown;
  }>,
  responses: Response[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }

    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init?.headers),
      jsonBody:
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    return response;
  }) as unknown as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeHeaders(
  headers: RequestInit["headers"] | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key.toLowerCase(),
      String(value),
    ]),
  );
}

function testPrivateKey(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

function createRequest(body: string, headers: Record<string, string>) {
  return {
    method: "POST",
    rawPath: "/",
    rawQueryString: "",
    headers,
    body,
  };
}

function createRepository() {
  return {
    full_name: "owner/repo",
    name: "repo",
    owner: { login: "owner" },
  };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;
}
