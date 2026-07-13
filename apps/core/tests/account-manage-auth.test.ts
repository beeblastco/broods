/**
 * Account-management route auth boundary tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  resetStorageForTests,
  setStorageForTests,
  type AccountRecord,
  type StorageProvider,
} from "../src/shared/storage/index.ts";
import { coreRequest } from "./helpers/http.ts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  resetStorageForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetStorageForTests();
});

describe("account-management deployment key auth", () => {
  it("no longer serves skill, tool, or cron routes for deployment keys — they are Convex config-plane routes", async () => {
    setStorageForTests(deploymentStorage());
    const { handler } = await import("../src/accounts/handler.ts");

    // Skills, tools, and cron CRUD moved to the Convex config plane — the
    // account handler no longer serves them for any principal.
    const skillsResponse = await handler(event("GET", "/v1/skills"));
    const toolsResponse = await handler(event("GET", "/v1/tools"));
    const cronsResponse = await handler(event("GET", "/v1/crons"));

    expect(skillsResponse.status).toBe(403);
    expect(toolsResponse.status).toBe(403);
    expect(cronsResponse.status).toBe(403);
  });
});

function deploymentStorage(): StorageProvider {
  const account: AccountRecord = {
    accountId: "acct_test",
    username: "acct",
    secretHash: "hash",
    status: "active",
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };

  return {
    kind: "convex",
    accounts: {
      async getById(accountId: string) {
        return accountId === account.accountId ? account : null;
      },
      async getBySecretHash() {
        return null;
      },
    },
    agentDeployments: {
      async getByApiKeyHash() {
        return {
          accountId: account.accountId,
          endpointId: "env-endpoint",
          projectSlug: "demo",
          environmentSlug: "development",
        };
      },
    },
  } as unknown as StorageProvider;
}

function event(method: string, rawPath: string) {
  return coreRequest(method, rawPath, { authorization: "Bearer runtime-key" });
}
