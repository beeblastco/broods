import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { CryptoKey } from "jose";
import type { AuthContext } from "../src/shared/auth.ts";
import type { AccountRecord } from "../src/shared/domain/accounts.ts";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { setStorageForTests, type Storage } from "../src/shared/storage.ts";
import { handleProtectedResourceRequest } from "../src/harness/mcp/authkit.ts";
import { handleMcpRequest } from "../src/harness/mcp-tasks.ts";

const DOMAIN = "https://auth.test";
const BASE = "https://api.test";
const ACCOUNT: AccountRecord = {
  accountId: "acct_1",
  username: "tester",
  secretHash: "hash",
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
const AGENT = {
  accountId: "acct_1",
  agentId: "agent_1",
  name: "helper",
  config: { publicAccess: false },
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
} as AgentRecord;
type StorageStubs = { [Store in keyof Storage]?: Partial<Storage[Store]> };

const askedOrgs: (string | undefined)[] = [];
const realFetch = globalThis.fetch;
let signingKey: CryptoKey;

beforeAll(async (): Promise<void> => {
  // Lazy, like authkit.ts: core's graph `require`s jose and must load it first.
  const { exportJWK, generateKeyPair } = await import("jose");
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  signingKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  globalThis.fetch = (async (input: string | URL | Request) =>
    (input instanceof Request ? input.url : input.toString()) ===
    `${DOMAIN}/oauth2/jwks`
      ? Response.json({ keys: [jwk] })
      : new Response("not found", { status: 404 })) as typeof fetch;
  process.env.WORKOS_AUTHKIT_DOMAIN = "auth.test";
  process.env.PUBLIC_BASE_URL = BASE;
  setStorageForTests({
    accounts: {
      getForUser: async (authId: string, org?: string) => {
        askedOrgs.push(org);

        return authId === "user_admin"
          ? { account: ACCOUNT }
          : { refused: "Signing in to Broods needs the owner or admin role" };
      },
    },
    agents: { listForAccount: async (): Promise<AgentRecord[]> => [AGENT] },
  } as StorageStubs as Storage);
});

afterEach((): void => {
  process.env.WORKOS_AUTHKIT_DOMAIN = "auth.test";
});

afterAll((): void => {
  globalThis.fetch = realFetch;
  delete process.env.WORKOS_AUTHKIT_DOMAIN;
  delete process.env.PUBLIC_BASE_URL;
  setStorageForTests(null);
});

describe("AuthKit sign-in at /mcp", () => {
  it("publishes AuthKit as the authorization server for /mcp", async () => {
    expect(await handleProtectedResourceRequest().json()).toEqual({
      resource: `${BASE}/mcp`,
      authorization_servers: [DOMAIN],
      bearer_methods_supported: ["header"],
      resource_name: "Broods",
    });
    delete process.env.WORKOS_AUTHKIT_DOMAIN;
    expect(handleProtectedResourceRequest().status).toBe(404);
  });

  it("points a caller with no credential at the metadata", async () => {
    const response = await handleMcpRequest(request(""), noReplay);

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      `Bearer realm="broods", resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });

  it("signs an admin's token in as their account, and replays with it", async () => {
    const replayed: AuthContext[] = [];
    const response = await handleMcpRequest(
      request(await token({}), "tools/call", {
        name: "helper",
        arguments: { prompt: "hi" },
      }),
      async (_request, auth): Promise<Response> => {
        replayed.push(auth);

        return Response.json({ runId: "run_1" }, { status: 202 });
      },
    );

    expect(response.status).toBe(200);
    expect(replayed[0]).toEqual({ kind: "account", account: ACCOUNT });
  });

  it("signs in to the org the MCP URL names", async () => {
    const named = request(await token({}));
    named.query = new URLSearchParams("org=acme");
    await handleMcpRequest(named, noReplay);

    expect(askedOrgs.at(-1)).toBe("acme");
  });

  it("refuses a token minted for another resource", async () => {
    const response = await handleMcpRequest(
      request(await token({ audience: "https://other.test" })),
      noReplay,
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  it("tells a member why they cannot sign in", async () => {
    const response = await handleMcpRequest(
      request(await token({ subject: "user_member" })),
      noReplay,
    );

    expect(response.status).toBe(403);
    expect(await response.text()).toContain("owner or admin role");
  });
});

async function noReplay(): Promise<Response> {
  throw new Error("nothing should replay");
}

function request(
  bearer: string,
  method = "tools/list",
  params: Record<string, unknown> = {},
): CoreRequest {
  return {
    method: "POST",
    path: "/mcp",
    search: "",
    query: new URLSearchParams(),
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      },
    }),
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

async function token(options: {
  audience?: string;
  subject?: string;
}): Promise<string> {
  const { SignJWT } = await import("jose");

  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(DOMAIN)
    .setAudience(options.audience ?? `${BASE}/mcp`)
    .setSubject(options.subject ?? "user_admin")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(signingKey);
}
