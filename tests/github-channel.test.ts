/**
 * GitHub channel adapter tests.
 * Cover webhook auth, allow-list handling, and issue/comment normalization here.
 */

import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createGitHubChannel } from "../functions/_shared/github-channel.ts";

describe("github channel adapter", () => {
  it("authenticates valid webhook signatures and rejects mismatches", () => {
    const body = JSON.stringify({
      action: "opened",
      repository: createRepository(),
      issue: { number: 1, title: "Issue title", body: "Issue body" },
      installation: { id: 99 },
    });

    const adapter = createGitHubChannel("webhook-secret", "app-id", "private-key", null);

    expect(adapter.authenticate(createRequest(body, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": sign(body),
    }))).toBe(true);

    expect(adapter.authenticate(createRequest(body, {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-1",
      "x-hub-signature-256": "sha256=bad",
    }))).toBe(false);
  });

  it("responds to ping events", () => {
    const adapter = createGitHubChannel("webhook-secret", "app-id", "private-key", null);

    const parsed = adapter.parse(createRequest(JSON.stringify({ zen: "pong" }), {
      "x-github-event": "ping",
    }));

    expect(parsed.kind).toBe("response");
    if (parsed.kind !== "response") {
      throw new Error("Expected GitHub ping to return a response");
    }

    expect(parsed.response.statusCode).toBe(200);
    expect(parsed.response.body).toBe("ok");
  });

  it("ignores repositories outside the allow list", () => {
    const adapter = createGitHubChannel("webhook-secret", "app-id", "private-key", new Set(["owner/allowed"]));

    const parsed = adapter.parse(createRequest(JSON.stringify({
      action: "opened",
      repository: createRepository(),
      issue: { number: 1, title: "Issue title", body: "Issue body" },
      installation: { id: 99 },
    }), {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-2",
    }));

    expect(parsed).toEqual({ kind: "ignore" });
  });

  it("normalizes issue events into issue conversation keys", () => {
    const adapter = createGitHubChannel("webhook-secret", "app-id", "private-key", null);

    const parsed = adapter.parse(createRequest(JSON.stringify({
      action: "opened",
      repository: createRepository(),
      issue: { number: 7, title: "Bug", body: "Details" },
      installation: { id: 99 },
    }), {
      "x-github-event": "issues",
      "x-github-delivery": "delivery-3",
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected GitHub issue event to be accepted");
    }

    expect(parsed.ack).toEqual({ statusCode: 200 });
    expect(parsed.message.eventId).toBe("gh:delivery-3");
    expect(parsed.message.conversationKey).toBe("gh:owner/repo:issue:7");
    expect(parsed.message.content).toEqual([{ type: "text", text: "Issue: Bug\n\nDetails" }]);
    expect(parsed.message.source).toEqual({
      owner: "owner",
      repo: "repo",
      installationId: 99,
      issueNumber: 7,
      target: "issue",
    });
  });

  it("routes pull request issue comments into pr conversation keys", () => {
    const adapter = createGitHubChannel("webhook-secret", "app-id", "private-key", null);

    const parsed = adapter.parse(createRequest(JSON.stringify({
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
    }), {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-4",
    }));

    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") {
      throw new Error("Expected GitHub PR comment to be accepted");
    }

    expect(parsed.message.conversationKey).toBe("gh:owner/repo:pr:12");
    expect(parsed.message.content).toEqual([{ type: "text", text: "Looks good" }]);
    expect(parsed.message.source).toEqual({
      owner: "owner",
      repo: "repo",
      installationId: 99,
      issueNumber: 12,
      commentId: 55,
      target: "issue_comment",
    });
  });

  it("ignores issue comments from bot actors", () => {
    const adapter = createGitHubChannel("webhook-secret", "app-id", "private-key", null);

    const parsed = adapter.parse(createRequest(JSON.stringify({
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
    }), {
      "x-github-event": "issue_comment",
      "x-github-delivery": "delivery-5",
    }));

    expect(parsed).toEqual({ kind: "ignore" });
  });
});

function createRequest(body: string, headers: Record<string, string>) {
  return {
    method: "POST",
    rawPath: "/",
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
