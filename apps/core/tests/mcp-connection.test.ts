/**
 * Server-run MCP OAuth: one bearer request starts it, the server owns PKCE and the code
 * exchange, and a rotated refresh token is saved.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { AuthContext } from "../src/shared/auth.ts";
import * as authModule from "../src/shared/auth.ts";
import type { AccountRecord } from "../src/shared/domain/accounts.ts";
import type { McpRecord } from "../src/shared/domain/mcp.ts";
import * as httpModule from "../src/shared/http.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { resetConnectionsForTests } from "../src/harness/connections.ts";
import {
  setStorageForTests,
  type Storage,
  type StoredMcpConnection,
} from "../src/shared/storage.ts";

const ISSUER = "https://auth.example.com";
const SERVER_URL = "https://mcp.example.com/mcp";
const ACCOUNT = { accountId: "acct_1" } as AccountRecord;
const tokenForms: URLSearchParams[] = [];
const saved: unknown[] = [];
let rotatedSaves: unknown[] = [];

await mock.module("../src/shared/auth.ts", () => ({
  ...authModule,
  resolveBearerAuth: async (
    headers: Record<string, string>,
  ): Promise<AuthContext | null> =>
    headers.authorization === "Bearer key"
      ? { kind: "account", account: ACCOUNT }
      : null,
}));
await mock.module("../src/shared/http.ts", () => ({
  ...httpModule,
  publicHostFetch: async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.includes("oauth-protected-resource")) {
      return Response.json({
        resource: SERVER_URL,
        authorization_servers: [ISSUER],
        scopes_supported: ["read"],
      });
    }
    if (url.includes("oauth-authorization-server")) {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === `${ISSUER}/register`) {
      return Response.json({
        client_id: "client_1",
        redirect_uris: ["https://broods.test/v1/mcp-connections/callback"],
      });
    }
    if (url === `${ISSUER}/token`) {
      tokenForms.push(new URLSearchParams(init?.body as string));

      return Response.json({
        access_token: "access_new",
        refresh_token: "refresh_new",
        expires_in: 3600,
      });
    }
    if (url === SERVER_URL) {
      return Response.json({
        auth: new Headers(init?.headers).get("authorization"),
      });
    }

    return new Response(null, { status: 404 });
  },
}));

const { handleMcpConnectionRequest, mcpConnectionFetch } =
  await import("../src/harness/mcp/connection.ts");

beforeEach((): void => {
  process.env.MEDIA_TICKET_SECRET = "test-secret";
  process.env.PUBLIC_BASE_URL = "https://broods.test";
  setStorageForTests({
    mcp: {
      getById: async (): Promise<McpRecord> => record(),
      setConnection: async (connection: unknown): Promise<boolean> => {
        saved.push(connection);

        return true;
      },
    },
  } as unknown as Storage);
});

afterEach((): void => {
  tokenForms.length = 0;
  saved.length = 0;
  rotatedSaves = [];
  setStorageForTests(null);
});

describe("MCP connections", () => {
  it("starts from a bare bearer request and finishes without the caller hashing anything", async () => {
    const started = await handleMcpConnectionRequest(
      request("POST", "/v1/mcp-connections/server_1"),
    );
    const { authorizeUrl } = (await started.json()) as { authorizeUrl: string };
    const link = new URL(authorizeUrl);

    expect(link.origin).toBe(ISSUER);
    expect(link.searchParams.get("code_challenge_method")).toBe("S256");
    expect(link.searchParams.get("resource")).toBe(SERVER_URL);

    const finished = await handleMcpConnectionRequest(
      request(
        "GET",
        "/v1/mcp-connections/callback",
        `code=code_1&state=${link.searchParams.get("state")}`,
        "",
      ),
    );

    expect(finished.status).toBe(200);
    expect(tokenForms[0]?.get("grant_type")).toBe("authorization_code");
    expect(tokenForms[0]?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(tokenForms[0]?.get("resource")).toBe(SERVER_URL);
    expect(saved[0]).toMatchObject({
      serverId: "server_1",
      accessToken: "access_new",
      refreshToken: "refresh_new",
    });
  });

  it("hands the account's own agent a link for the user, with no key or curl", async () => {
    const { mcpSignInTool } = await import("../src/harness/mcp/mcp.tool.ts");
    const execute = mcpSignInTool(record(), true).execute as (
      input: object,
      options: never,
    ) => Promise<string>;

    expect(await execute({}, {} as never)).toContain(
      `Give the user this link to sign in to linked: ${ISSUER}/authorize?`,
    );
  });

  it("refuses a forged sign-in state", async () => {
    const response = await handleMcpConnectionRequest(
      request(
        "GET",
        "/v1/mcp-connections/callback",
        "code=code_1&state=forged",
        "",
      ),
    );

    expect(response.status).toBe(400);
    expect(saved).toEqual([]);
  });

  it("refuses a request with no credential", async () => {
    const response = await handleMcpConnectionRequest(
      request("POST", "/v1/mcp-connections/server_1", "", ""),
    );

    expect(response.status).toBe(401);
  });

  it("answers a malformed escape in the server id as not found", async () => {
    const response = await handleMcpConnectionRequest(
      request("GET", "/v1/mcp-connections/%E0"),
    );

    expect(response.status).toBe(404);
  });

  it("saves the refresh token a rotating server hands back", async () => {
    const stored: StoredMcpConnection = {
      clientId: "client_1",
      tokenUrl: `${ISSUER}/token`,
      resource: SERVER_URL,
      accessToken: "access_old",
      refreshToken: "refresh_old",
      expiresAt: Date.now() - 1,
      updatedAt: 1,
    };
    setStorageForTests({
      mcp: {
        loadConnection: async (): Promise<StoredMcpConnection> => stored,
        saveRefreshedConnection: async (
          _accountId: string,
          _serverId: string,
          _loaded: StoredMcpConnection,
          rotated: unknown,
        ): Promise<boolean> => {
          rotatedSaves.push(rotated);

          return true;
        },
      },
    } as unknown as Storage);

    const response = await mcpConnectionFetch(record())(SERVER_URL);

    expect(await response.json()).toEqual({ auth: "Bearer access_new" });
    expect(tokenForms[0]?.get("refresh_token")).toBe("refresh_old");
    expect(rotatedSaves[0]).toMatchObject({ refreshToken: "refresh_new" });
  });

  it("opens a sign-in started before the secret rotated", async () => {
    const started = await handleMcpConnectionRequest(
      request("POST", "/v1/mcp-connections/server_1"),
    );
    const { authorizeUrl } = (await started.json()) as { authorizeUrl: string };
    process.env.MEDIA_TICKET_SECRET = "next-secret,test-secret";

    const finished = await handleMcpConnectionRequest(
      request(
        "GET",
        "/v1/mcp-connections/callback",
        `code=code_1&state=${new URL(authorizeUrl).searchParams.get("state")}`,
        "",
      ),
    );

    expect(finished.status).toBe(200);
  });

  it("stops sending the cached token once the connection is deleted", async () => {
    resetConnectionsForTests();
    let stored: StoredMcpConnection = {
      clientId: "client_1",
      tokenUrl: `${ISSUER}/token`,
      resource: SERVER_URL,
      accessToken: "access_first",
      refreshToken: "refresh_1",
      expiresAt: Date.now() + 3_600_000,
      updatedAt: 1,
    };
    setStorageForTests({
      mcp: {
        getById: async (): Promise<McpRecord> => record(),
        loadConnection: async (): Promise<StoredMcpConnection> => stored,
        disconnect: async (): Promise<boolean> => {
          stored = { ...stored, accessToken: "access_second", updatedAt: 2 };

          return true;
        },
      },
    } as unknown as Storage);
    const auth = async (): Promise<unknown> =>
      await (await mcpConnectionFetch(record())(SERVER_URL)).json();

    expect(await auth()).toEqual({ auth: "Bearer access_first" });
    await handleMcpConnectionRequest(
      request("DELETE", "/v1/mcp-connections/server_1"),
    );
    expect(await auth()).toEqual({ auth: "Bearer access_second" });
  });
});

function record(): McpRecord {
  return {
    accountId: "acct_1",
    serverId: "server_1",
    projectId: "project_1",
    stageId: "stage_1",
    name: "linked",
    transport: "http",
    url: SERVER_URL,
    connected: true,
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

function request(
  method: string,
  path: string,
  search = "",
  token = "key",
): CoreRequest {
  return {
    method: method,
    path: path,
    search: search,
    query: new URLSearchParams(search),
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: "",
    clientIp: "127.0.0.1",
  };
}
