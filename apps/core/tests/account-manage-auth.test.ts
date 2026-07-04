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
import { coreRequest, responseJson } from "./helpers/http.ts";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
  process.env.SERVICE_AUTH_SECRET = "service-secret";
  process.env.CRONS_TABLE_NAME = "crons";
  process.env.CRON_SCHEDULER_TARGET_ARN = "arn:aws:lambda:us-east-1:123456789012:function:test";
  process.env.CRON_SCHEDULER_ROLE_ARN = "arn:aws:iam::123456789012:role/test";
  process.env.CRON_SCHEDULER_GROUP_NAME = "test-group";
  resetStorageForTests();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  resetStorageForTests();
});

describe("account-management deployment key auth", () => {
  it("rejects deployment runtime keys on skill and tool self routes but keeps cron self routes allowed", async () => {
    setStorageForTests(deploymentStorage());
    const { handler } = await import("../src/accounts/handler.ts");

    const skillsResponse = await handler(event("GET", "/accounts/me/skills"));
    const toolsResponse = await handler(event("GET", "/accounts/me/tools"));
    const cronsResponse = await handler(event("GET", "/accounts/me/crons"));

    expect(skillsResponse.status).toBe(401);
    expect(toolsResponse.status).toBe(401);
    expect(cronsResponse.status).toBe(200);
    expect(await responseJson(cronsResponse)).toEqual({ crons: [] });
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
    kind: "dynamodb",
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
    crons: {
      async list() {
        return [];
      },
    },
  } as unknown as StorageProvider;
}

function event(method: string, rawPath: string) {
  return coreRequest(method, rawPath, { authorization: "Bearer runtime-key" });
}
