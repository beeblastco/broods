/**
 * GitHub outbound action tests.
 * Cover installation auth and outbound REST routing here.
 */

import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { GitHubSource } from "../functions/_shared/github-channel.ts";
import { createGitHubActions } from "../functions/_shared/github.ts";

const TEST_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIICdgIBADANBgkqhkiG9w0BAQEFAASCAmAwggJcAgEAAoGBAMzqaeVzkNVUJzir
DBrjhLD4tODAd7jL+H7ySrNqxRd8yvvpnd66syaFtM8oaXnSjpK9QhyUXSy5aSLp
t+Oc49hp7VQcECLK38G8JintCevS66JREtqXfd7lTLigDXYvfd445FhN9QUi87VM
h1NJRyID8Pq8ncZvocw9FAlHaK9TAgMBAAECgYBxFYBBPwiTofBPJp30jNCidW4k
hjLLycymCgJNh0OjVZwTb3ZO/0t0m98PX6btstQ5iLZeXUYaM2wg90gjFWbq/3au
Yena/lXbzNOV2+kgzHqpvnLEKerhLqdYomL7/bGVLOtzE3Gb6AMOn4UclRJ9o53D
bW7ryJPsYC0A66BdkQJBAO3/V+1sdAOj5TdYswk6CHeol7jqs64EndMqwbMCCqP7
2Q/8j/ki7RVfFkDIKpsX1mn60KlMOcD+q1qhYHmHG5kCQQDcanb4zrK0kcicG88a
Was24iNhttawZrVZVh2BI5UpEPW0UI/yUIYNWOPp1ime2kmKduHrCmsdC9Z0rrCH
fFXLAkA6PQKiKajV/zQm8ACXoGjUByBhcqVXTu/j7ZGKoVRDPmymWdJNT7ueQC9s
2M58N0ATnPmUg/+Z93es7NJzypj5AkEAjoiaXtLrZTFQ1QJ2rseFnHwn/SxLMM96
Pkcd1UC5WFELUos2SrAfv8nXuIMxbvQh0lSGS4P1OFdLWzEMHtEceQJAOnlnP5oP
ovgrNGj9AGwL11bU+ZWdQbqcnG2cgbsZUZZzceuMbUE9luwFI2t0+M1pK+qYwy9Q
MZJDcwOX3RDeTA==
-----END PRIVATE KEY-----`;

describe("github outbound actions", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setSystemTime(new Date("2026-04-24T00:00:00.000Z"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSystemTime();
  });

  it("reuses one installation token for issue comments and reactions", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [
      jsonResponse(201, { token: "installation-token" }),
      emptyResponse(201),
      emptyResponse(201),
    ]);

    const actions = createGitHubActions(
      "app-123",
      Buffer.from(TEST_PRIVATE_KEY).toString("base64"),
      createSource({ issueNumber: 7, target: "issue" }),
    );

    await actions.sendText("hello from bun");
    await actions.reactToMessage();

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe("https://api.github.com/app/installations/99/access_tokens");
    expect(calls[1]?.url).toBe("https://api.github.com/repos/owner/repo/issues/7/comments");
    expect(calls[2]?.url).toBe("https://api.github.com/repos/owner/repo/issues/7/reactions");

    expect(calls[1]?.jsonBody).toEqual({ body: "hello from bun" });
    expect(calls[2]?.jsonBody).toEqual({ content: "eyes" });
    expect(calls[1]?.headers.authorization).toBe("Bearer installation-token");
    expect(calls[2]?.headers.authorization).toBe("Bearer installation-token");

    expect(calls[0]?.headers.accept).toBe("application/vnd.github+json");
    expect(calls[0]?.headers["x-github-api-version"]).toBe("2022-11-28");
    const claims = decodeJwtClaims(calls[0]?.headers.authorization);
    expect(claims).toEqual({
      iss: "app-123",
      iat: 1_776_988_740,
      exp: 1_776_989_340,
    });
  });

  it("routes review comment replies and reactions through pull request review endpoints", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [
      jsonResponse(201, { token: "review-token" }),
      emptyResponse(201),
      emptyResponse(201),
    ]);

    const actions = createGitHubActions(
      "app-123",
      TEST_PRIVATE_KEY,
      createSource({
        target: "pull_request_review_comment",
        pullNumber: 12,
        commentId: 55,
      }),
    );

    await actions.sendText("reply body");
    await actions.reactToMessage();

    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toBe(
      "https://api.github.com/repos/owner/repo/pulls/12/comments/55/replies",
    );
    expect(calls[2]?.url).toBe(
      "https://api.github.com/repos/owner/repo/pulls/comments/55/reactions",
    );
    expect(calls[1]?.jsonBody).toEqual({ body: "reply body" });
    expect(calls[2]?.jsonBody).toEqual({ content: "eyes" });
  });

  it("uses issue comment reactions for issue comment sources", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [
      jsonResponse(201, { token: "comment-token" }),
      emptyResponse(201),
      emptyResponse(201),
    ]);

    const actions = createGitHubActions(
      "app-123",
      TEST_PRIVATE_KEY,
      createSource({
        issueNumber: 12,
        commentId: 77,
        target: "issue_comment",
      }),
    );

    await actions.sendText("follow-up");
    await actions.reactToMessage();

    expect(calls).toHaveLength(3);
    expect(calls[1]?.url).toBe("https://api.github.com/repos/owner/repo/issues/12/comments");
    expect(calls[2]?.url).toBe("https://api.github.com/repos/owner/repo/issues/comments/77/reactions");
    expect(calls[1]?.jsonBody).toEqual({ body: "follow-up" });
    expect(calls[2]?.jsonBody).toEqual({ content: "eyes" });
  });

  it("throws when sendText cannot resolve an issue number", async () => {
    const calls: FetchCall[] = [];
    globalThis.fetch = createFetchMock(calls, [
      jsonResponse(201, { token: "pull-request-token" }),
    ]);

    const actions = createGitHubActions(
      "app-123",
      TEST_PRIVATE_KEY,
      createSource({ target: "pull_request", pullNumber: 12 }),
    );

    await expect(actions.sendText("cannot send")).rejects.toThrow(
      "GitHub sendText requires an issue or pull request number",
    );

    expect(calls).toHaveLength(1);
  });
});

interface FetchCall {
  headers: Record<string, string>;
  jsonBody: unknown;
  method: string;
  url: string;
}

function createFetchMock(calls: FetchCall[], responses: Response[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected fetch: ${String(input)}`);
    }

    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: normalizeHeaders(init?.headers),
      jsonBody: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });

    return response;
  }) as unknown as typeof fetch;
}

function createSource(overrides: Partial<GitHubSource>): GitHubSource {
  return {
    owner: "owner",
    repo: "repo",
    installationId: 99,
    target: "issue",
    ...overrides,
  };
}

function decodeJwtClaims(authorizationHeader: string | undefined) {
  const token = authorizationHeader?.replace(/^Bearer\s+/, "");
  if (!token) {
    throw new Error("Missing authorization header");
  }

  const [, payload] = token.split(".");
  if (!payload) {
    throw new Error("Expected JWT payload segment");
  }

  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeHeaders(headers: RequestInit["headers"] | undefined): Record<string, string> {
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
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
}
