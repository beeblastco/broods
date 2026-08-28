/**
 * Bearer auth tests: admin secret, service-token path, deployment API keys,
 * role sessions, and account lookup.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentRecord } from "../src/shared/domain/agents.ts";
import {
  hashAccountSecret,
  type AccountRecord,
} from "../src/shared/domain/accounts.ts";
import type { RolePrincipal } from "@broods/convex/model/apiAuthorization";
import {
  resetStorageForTests,
  setStorageForTests,
  type Storage,
} from "../src/shared/storage.ts";
import { extractBearerToken, resolveBearerAuth } from "../src/shared/auth.ts";

const ACCOUNT: AccountRecord = {
  accountId: "acct_1",
  username: "tester",
  secretHash: hashAccountSecret("fp_acct_known-secret"),
  status: "active",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
const AGENT: AgentRecord = {
  accountId: "acct_1",
  agentId: "agent_1",
  name: "Tester",
  status: "active",
  config: {},
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
};
const DEPLOYMENT_API_KEY = "fp_agent_known-key";
const ROLE_PRINCIPAL: RolePrincipal = {
  accountId: "acct_1",
  roleId: "fp_role_1",
  policy: {
    version: 1,
    rules: [{ id: "r1", effect: "allow", actions: ["sandboxes:write"] }],
  },
};
const ROLE_SESSION_TOKEN = "fp_sts_known-session";

let accountsById: Record<string, AccountRecord>;
let accountsBySecretHash: Record<string, AccountRecord>;
let agentsById: Record<string, AgentRecord>;
let roleSessionsByTokenHash: Record<string, RolePrincipal>;

beforeEach(() => {
  process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  accountsById = { [ACCOUNT.accountId]: ACCOUNT };
  accountsBySecretHash = { [ACCOUNT.secretHash]: ACCOUNT };
  agentsById = { [AGENT.agentId]: AGENT };
  roleSessionsByTokenHash = {
    [sha256Hex(ROLE_SESSION_TOKEN)]: ROLE_PRINCIPAL,
  };
  setStorageForTests({
    accounts: {
      getById: async (accountId: string) => accountsById[accountId] ?? null,
      getBySecretHash: async (secretHash: string) =>
        accountsBySecretHash[secretHash] ?? null,
    },
    agents: {
      getById: async (_accountId: string, agentId: string) =>
        agentsById[agentId] ?? null,
    },
    agentDeployments: {
      getByApiKeyHash: async (apiKeyHash: string) =>
        apiKeyHash === sha256Hex(DEPLOYMENT_API_KEY)
          ? {
              accountId: ACCOUNT.accountId,
              endpointId: "env-endpoint",
              projectSlug: "demo",
              stageSlug: "development",
            }
          : null,
    },
    roleSessions: {
      resolveByTokenHash: async (tokenHash: string) =>
        roleSessionsByTokenHash[tokenHash] ?? null,
    },
  } as unknown as Storage);
});

afterEach(() => {
  resetStorageForTests();
});

describe("extractBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
  });

  it("rejects malformed headers", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("Bearer")).toBeNull();
    expect(extractBearerToken("Bearer a b")).toBeNull();
    expect(extractBearerToken("Basic abc")).toBeNull();
  });
});

describe("resolveBearerAuth", () => {
  it("resolves the admin secret", async () => {
    const auth = await resolveBearerAuth({
      authorization: "Bearer admin-secret",
    });
    expect(auth).toEqual({ kind: "admin" });
  });

  it("resolves an account by secret hash", async () => {
    const auth = await resolveBearerAuth({
      authorization: "Bearer fp_acct_known-secret",
    });
    expect(auth).toMatchObject({
      kind: "account",
      account: { accountId: "acct_1" },
    });
  });

  it("resolves a project/stage runtime API key", async () => {
    const auth = await resolveBearerAuth({
      authorization: `Bearer ${DEPLOYMENT_API_KEY}`,
    });
    expect(auth).toMatchObject({
      kind: "deployment",
      account: { accountId: "acct_1" },
      endpointId: "env-endpoint",
      projectSlug: "demo",
      stageSlug: "development",
    });
  });

  it("resolves an fp_sts_ role session to role auth", async () => {
    const auth = await resolveBearerAuth({
      authorization: `Bearer ${ROLE_SESSION_TOKEN}`,
    });
    expect(auth).toMatchObject({
      kind: "role",
      account: { accountId: "acct_1" },
      role: { roleId: "fp_role_1" },
    });
  });

  it("rejects unknown or foreign fp_sts_ tokens without falling through", async () => {
    expect(
      await resolveBearerAuth({ authorization: "Bearer fp_sts_unknown" }),
    ).toBeNull();
  });

  it("rejects role sessions whose account is disabled", async () => {
    accountsById.acct_1 = { ...ACCOUNT, status: "disabled" };
    expect(
      await resolveBearerAuth({
        authorization: `Bearer ${ROLE_SESSION_TOKEN}`,
      }),
    ).toBeNull();
  });

  it("rejects unknown tokens", async () => {
    expect(
      await resolveBearerAuth({ authorization: "Bearer nope" }),
    ).toBeNull();
    expect(await resolveBearerAuth({})).toBeNull();
  });

  it("resolves the service token only with a valid X-Account-Id header", async () => {
    const auth = await resolveBearerAuth({
      authorization: "Bearer service-secret",
      "x-account-id": "acct_1",
    });
    expect(auth).toMatchObject({
      kind: "account",
      viaServiceToken: true,
      account: { accountId: "acct_1" },
    });

    expect(
      await resolveBearerAuth({ authorization: "Bearer service-secret" }),
    ).toBeNull();
    expect(
      await resolveBearerAuth({
        authorization: "Bearer service-secret",
        "x-account-id": "acct_missing",
      }),
    ).toBeNull();
  });

  it("rejects the service token for disabled accounts", async () => {
    accountsById.acct_1 = { ...ACCOUNT, status: "disabled" };
    const headers = {
      authorization: "Bearer service-secret",
      "x-account-id": "acct_1",
    };

    expect(await resolveBearerAuth(headers)).toBeNull();
    expect(
      await resolveBearerAuth(headers, { allowDisabledAccountSecret: true }),
    ).toBeNull();
  });

  it("rejects disabled accounts on the secret-hash path", async () => {
    accountsBySecretHash[ACCOUNT.secretHash] = {
      ...ACCOUNT,
      status: "disabled",
    };
    expect(
      await resolveBearerAuth({ authorization: "Bearer fp_acct_known-secret" }),
    ).toBeNull();
  });

  it("allows a disabled account secret only for an explicit deletion retry", async () => {
    accountsBySecretHash[ACCOUNT.secretHash] = {
      ...ACCOUNT,
      status: "disabled",
    };
    const headers = { authorization: "Bearer fp_acct_known-secret" };

    expect(await resolveBearerAuth(headers)).toBeNull();
    expect(
      await resolveBearerAuth(headers, { allowDisabledAccountSecret: true }),
    ).toMatchObject({
      kind: "account",
      account: { accountId: "acct_1", status: "disabled" },
    });
  });
});

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
