/**
 * OAuth refresh-token grant for external MCP servers: token mint, caching and
 * margin-driven re-mint in harness/mcp/oauth.ts, plus mcpConnection's oauth
 * overlay and its refusal of an Authorization header next to oauth.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mcpConnection } from "../src/harness/mcp/client.ts";
import {
  clearMcpOauthTokens,
  mcpAccessToken,
  type ResolvedMcpOauth,
} from "../src/harness/mcp/oauth.ts";
import type { McpRecord } from "../src/shared/domain/mcp.ts";

const TOKEN_URL = "https://oauth.test/token";

const originalFetch = globalThis.fetch;

/** One resolved oauth config; field overrides per test. */
function resolvedOauth(
  overrides: Partial<ResolvedMcpOauth> = {},
): ResolvedMcpOauth {
  return {
    clientId: "client-1",
    clientSecret: "secret-1",
    refreshToken: "refresh-1",
    tokenUrl: TOKEN_URL,
    ...overrides,
  };
}

/** An external row carrying oauth with the ${NAME} refs a stored row holds. */
function oauthRecord(overrides: Partial<McpRecord> = {}): McpRecord {
  const now = new Date().toISOString();

  return {
    accountId: "acct_test",
    serverId: "mcp_row_1",
    projectId: "proj",
    stageId: "stage",
    name: "gmail",
    transport: "http",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    oauth: {
      clientId: "client-1",
      clientSecret: "${GMAIL_CLIENT_SECRET}",
      refreshToken: "${GMAIL_REFRESH_TOKEN}",
    },
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Stub the token endpoint; returns the recorded requests. */
function stubTokenEndpoint(
  responses: Array<{ status?: number; body: unknown }>,
): Array<{ url: string; body: string; redirect: RequestInit["redirect"] }> {
  const requests: Array<{
    url: string;
    body: string;
    redirect: RequestInit["redirect"];
  }> = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({
      url: String(input),
      body: String(init?.body ?? ""),
      redirect: init?.redirect,
    });
    const next = responses[Math.min(requests.length, responses.length) - 1]!;

    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  }) as typeof fetch;

  return requests;
}

describe("mcp oauth access tokens", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearMcpOauthTokens();
  });

  it("mints a token with a form-encoded refresh-token grant", async () => {
    const requests = stubTokenEndpoint([
      { body: { access_token: "token-a", expires_in: 3600 } },
    ]);

    const token = await mcpAccessToken("gmail", resolvedOauth());

    expect(token).toBe("token-a");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(TOKEN_URL);
    expect(requests[0]!.redirect).toBe("error");
    const params = new URLSearchParams(requests[0]!.body);
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("client_id")).toBe("client-1");
    expect(params.get("client_secret")).toBe("secret-1");
    expect(params.get("refresh_token")).toBe("refresh-1");
  });

  it("serves a fresh token from the cache without a second mint", async () => {
    const requests = stubTokenEndpoint([
      { body: { access_token: "token-a", expires_in: 3600 } },
    ]);

    await mcpAccessToken("gmail", resolvedOauth());
    const again = await mcpAccessToken("gmail", resolvedOauth());

    expect(again).toBe("token-a");
    expect(requests).toHaveLength(1);
  });

  it("re-mints once the cached token is inside the refresh margin", async () => {
    // expires_in 60s minus the 60s margin leaves an already-stale entry.
    const requests = stubTokenEndpoint([
      { body: { access_token: "token-a", expires_in: 60 } },
      { body: { access_token: "token-b", expires_in: 3600 } },
    ]);

    expect(await mcpAccessToken("gmail", resolvedOauth())).toBe("token-a");
    expect(await mcpAccessToken("gmail", resolvedOauth())).toBe("token-b");
    expect(requests).toHaveLength(2);
  });

  it("shares one re-mint between callers that awaited the same stale entry", async () => {
    const requests = stubTokenEndpoint([
      { body: { access_token: "token-a", expires_in: 60 } },
      { body: { access_token: "token-b", expires_in: 3600 } },
    ]);

    await mcpAccessToken("gmail", resolvedOauth());
    const tokens = await Promise.all([
      mcpAccessToken("gmail", resolvedOauth()),
      mcpAccessToken("gmail", resolvedOauth()),
    ]);

    expect(tokens).toEqual(["token-b", "token-b"]);
    expect(requests).toHaveLength(2);
  });

  it("caches per oauth config, not per server name", async () => {
    const requests = stubTokenEndpoint([
      { body: { access_token: "token-a", expires_in: 3600 } },
    ]);

    await mcpAccessToken("gmail", resolvedOauth());
    await mcpAccessToken("gmail", resolvedOauth({ refreshToken: "refresh-2" }));
    await mcpAccessToken("gmail", resolvedOauth({ clientSecret: "secret-2" }));

    expect(requests).toHaveLength(3);
  });

  it("surfaces a failed refresh as an error naming the server", async () => {
    stubTokenEndpoint([{ status: 400, body: { error: "invalid_grant" } }]);

    await expect(mcpAccessToken("gmail", resolvedOauth())).rejects.toThrow(
      /MCP server gmail: OAuth token refresh.*invalid_grant/,
    );
  });

  it("retries after a failed mint instead of caching the error", async () => {
    const requests = stubTokenEndpoint([
      { status: 500, body: { error: "boom" } },
      { body: { access_token: "token-b", expires_in: 3600 } },
    ]);

    await expect(mcpAccessToken("gmail", resolvedOauth())).rejects.toThrow();
    expect(await mcpAccessToken("gmail", resolvedOauth())).toBe("token-b");
    expect(requests).toHaveLength(2);
  });
});

describe("mcpConnection oauth overlay", () => {
  it("overlays the agent config's resolved values and defaults tokenUrl", () => {
    const connection = mcpConnection(oauthRecord(), undefined, {
      clientSecret: "resolved-secret",
      refreshToken: "resolved-refresh",
    });

    expect(connection.oauth).toEqual({
      clientId: "client-1",
      clientSecret: "resolved-secret",
      refreshToken: "resolved-refresh",
      tokenUrl: "https://oauth2.googleapis.com/token",
    });
  });

  it("takes tokenUrl from the row, never from the agent config", () => {
    const record = oauthRecord({
      oauth: {
        clientId: "client-1",
        clientSecret: "${GMAIL_CLIENT_SECRET}",
        refreshToken: "${GMAIL_REFRESH_TOKEN}",
        tokenUrl: "https://oauth.test/token",
      },
    });
    // Sync only validates the agent entry as a string record, so an
    // endpoint smuggled in there must not win over the checked row value.
    const smuggled = {
      clientSecret: "resolved-secret",
      refreshToken: "resolved-refresh",
      tokenUrl: "http://attacker.test/token",
    };
    const connection = mcpConnection(record, undefined, smuggled);

    expect(connection.oauth?.tokenUrl).toBe("https://oauth.test/token");
  });

  it("refuses oauth values still carrying a ${NAME} ref", () => {
    expect(() => mcpConnection(oauthRecord(), undefined)).toThrow(
      /oauth clientSecret still carries a \$\{NAME\} ref/,
    );
  });

  it("refuses an Authorization header next to oauth", () => {
    expect(() =>
      mcpConnection(
        oauthRecord(),
        { Authorization: "Bearer static" },
        {
          clientSecret: "resolved-secret",
          refreshToken: "resolved-refresh",
        },
      ),
    ).toThrow(/sets both an Authorization header and oauth/);
  });

  it("leaves connections without oauth untouched", () => {
    const record = oauthRecord({ oauth: undefined });
    const connection = mcpConnection(record, { "X-Extra": "1" });

    expect(connection.oauth).toBeUndefined();
    expect(connection.headers).toEqual({ "X-Extra": "1" });
  });
});
