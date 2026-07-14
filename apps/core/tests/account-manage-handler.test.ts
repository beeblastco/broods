import { afterEach, describe, expect, it, mock } from "bun:test";
import { S3Client } from "@aws-sdk/client-s3";
import { handler } from "../src/accounts/handler.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { hashAccountSecret } from "../src/shared/domain/accounts.ts";
import { resetCoreStoreForTests, setCoreStoreForTests } from "../src/shared/core-store.ts";
import { runtimePersistence } from "../src/shared/convex/runtime.ts";

const originalAdminSecret = process.env.ADMIN_ACCOUNT_SECRET;
const originalServiceSecret = process.env.SERVICE_AUTH_SECRET;
const originalCronsTable = process.env.CRONS_TABLE_NAME;
const originalSchedulerRoleArn = process.env.CRON_SCHEDULER_ROLE_ARN;
const originalSchedulerTargetArn = process.env.CRON_SCHEDULER_TARGET_ARN;
const originalSchedulerGroupName = process.env.CRON_SCHEDULER_GROUP_NAME;
const originalSkillsBucketName = process.env.SKILLS_BUCKET_NAME;
const originalToolBundlesBucketName = process.env.TOOL_BUNDLES_BUCKET_NAME;
const originalRuntimeMutation = runtimePersistence.mutation;
const originalS3Send = S3Client.prototype.send;

afterEach(() => {
  if (originalAdminSecret === undefined) {
    delete process.env.ADMIN_ACCOUNT_SECRET;
  } else {
    process.env.ADMIN_ACCOUNT_SECRET = originalAdminSecret;
  }
  if (originalServiceSecret === undefined) {
    delete process.env.SERVICE_AUTH_SECRET;
  } else {
    process.env.SERVICE_AUTH_SECRET = originalServiceSecret;
  }
  if (originalCronsTable === undefined) {
    delete process.env.CRONS_TABLE_NAME;
  } else {
    process.env.CRONS_TABLE_NAME = originalCronsTable;
  }
  if (originalSchedulerRoleArn === undefined) {
    delete process.env.CRON_SCHEDULER_ROLE_ARN;
  } else {
    process.env.CRON_SCHEDULER_ROLE_ARN = originalSchedulerRoleArn;
  }
  if (originalSchedulerTargetArn === undefined) {
    delete process.env.CRON_SCHEDULER_TARGET_ARN;
  } else {
    process.env.CRON_SCHEDULER_TARGET_ARN = originalSchedulerTargetArn;
  }
  if (originalSchedulerGroupName === undefined) {
    delete process.env.CRON_SCHEDULER_GROUP_NAME;
  } else {
    process.env.CRON_SCHEDULER_GROUP_NAME = originalSchedulerGroupName;
  }
  if (originalSkillsBucketName === undefined) delete process.env.SKILLS_BUCKET_NAME;
  else process.env.SKILLS_BUCKET_NAME = originalSkillsBucketName;
  if (originalToolBundlesBucketName === undefined) delete process.env.TOOL_BUNDLES_BUCKET_NAME;
  else process.env.TOOL_BUNDLES_BUCKET_NAME = originalToolBundlesBucketName;
  runtimePersistence.mutation = originalRuntimeMutation;
  S3Client.prototype.send = originalS3Send;
  setCoreStoreForTests(null);
  resetCoreStoreForTests();
});

describe("account management HTTP handler", () => {
  it("returns a JSON health response", async () => {
    const response = await handler(createEvent("GET", "/"));

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual({ status: "ok" });
  });

  it("returns JSON errors for missing auth on retained account delete", async () => {
    const response = await handler(createEvent("DELETE", "/v1/account"));

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("requires bearer auth to create an account", async () => {
    setCoreStoreForTests(createFakeStorage({
      async create() {
        throw new Error("create should not be called");
      },
    }));

    const response = await handler(createEvent("POST", "/accounts", {}, {
      username: "company-a",
      description: "Company A account",
    }));

    expect(response.status).toBe(401);
    expect(await responseJson(response)).toEqual({ error: "Unauthorized" });
  });

  it("rejects account-secret auth when creating an account", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    const accountSecret = "fp_acct_existing";
    setCoreStoreForTests(createFakeStorage({
      accounts: {
        async getBySecretHash(secretHash: string) {
          return secretHash === hashAccountSecret(accountSecret) ? fakeAccount() : null;
        },
        async create() {
          throw new Error("create should not be called");
        },
      },
    }));

    const response = await handler(createEvent("POST", "/accounts", {
      authorization: `Bearer ${accountSecret}`,
    }, {
      username: "company-a",
      description: "Company A account",
    }));

    expect(response.status).toBe(403);
    expect(await responseJson(response)).toEqual({ error: "Forbidden" });
  });

  it("returns create account one-time secret as secret for admin auth", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    setCoreStoreForTests(createFakeStorage({
      async create() {
        return {
          account: fakeAccount(),
          secret: "fp_acct_created",
        };
      },
    }));

    const response = await handler(createEvent("POST", "/accounts", {
      authorization: "Bearer admin-secret",
    }, {
      username: "company-a",
      description: "Company A account",
    }));

    expect(response.status).toBe(201);
    expect(await responseJson(response)).toEqual({
      account: {
        accountId: "acct_test",
        username: "company-a",
        description: "Company A account",
      },
      secret: "fp_acct_created",
    });
  });

  it("no longer serves account metadata or rotation routes", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setCoreStoreForTests(createFakeStorage({}));

    for (const path of ["/accounts", "/accounts/acct_test", "/accounts/acct_test/rotate-secret"]) {
      const adminResponse = await handler(createEvent(path.endsWith("rotate-secret") ? "POST" : "GET", path, {
        authorization: "Bearer admin-secret",
      }));
      expect(adminResponse.status).toBe(404);
      expect(await responseJson(adminResponse)).toEqual({ error: "Not found" });
    }

    const adminPatchResponse = await handler(createEvent("PATCH", "/accounts/acct_test", {
      authorization: "Bearer admin-secret",
    }, { username: "next" }));
    expect(adminPatchResponse.status).toBe(404);
    expect(await responseJson(adminPatchResponse)).toEqual({ error: "Not found" });

    for (const path of ["/v1/account", "/v1/account/rotate-secret"]) {
      const serviceResponse = await handler(createEvent(path.endsWith("rotate-secret") ? "POST" : "GET", path, {
        authorization: "Bearer service-secret",
        "x-account-id": "acct_test",
      }));
      expect(serviceResponse.status).toBe(403);
      expect(await responseJson(serviceResponse)).toEqual({ error: "Forbidden" });
    }
  });

  it("returns JSON not found errors for authenticated admin requests", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    const response = await handler(createEvent("GET", "/missing", {
      authorization: "Bearer admin-secret",
    }));

    expect(response.status).toBe(404);
    expect(await responseJson(response)).toEqual({ error: "Not found" });
  });

  it("no longer serves cron CRUD — those routes live in the Convex config plane", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setCoreStoreForTests(createFakeStorage({}));

    // Admin cron routes were removed with the rest of the cron plane.
    const adminResponse = await handler(createEvent("GET", "/accounts/acct_test/crons", {
      authorization: "Bearer admin-secret",
    }));
    expect(adminResponse.status).toBe(404);
    expect(await responseJson(adminResponse)).toEqual({ error: "Not found" });

    // Account-authenticated config-plane CRUD routes fall through to the admin gate.
    for (const path of ["/v1/crons", "/v1/policies", "/v1/sandboxes", "/v1/workspaces"]) {
      const serviceResponse = await handler(createEvent("GET", path, {
        authorization: "Bearer service-secret",
        "x-account-id": "acct_test",
      }));
      expect(serviceResponse.status).toBe(403);
      expect(await responseJson(serviceResponse)).toEqual({ error: "Forbidden" });
    }

    for (const path of [
      "/accounts/acct_test/agents",
      "/accounts/acct_test/agents/agent_1",
      "/accounts/acct_test/policies",
      "/accounts/acct_test/sandboxes",
      "/accounts/acct_test/workspaces",
    ]) {
      const removedAdminResponse = await handler(createEvent("GET", path, {
        authorization: "Bearer admin-secret",
      }));
      expect(removedAdminResponse.status).toBe(404);
      expect(await responseJson(removedAdminResponse)).toEqual({ error: "Not found" });
    }
  });

  it("rejects service tokens on retained account delete", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    setCoreStoreForTests(createFakeStorage({}));
    const serviceHeaders = {
      authorization: "Bearer service-secret",
      "x-account-id": "acct_test",
    };
    const serviceTokenRejection = { error: "Service token is not allowed for this account endpoint" };

    const response = await handler(createEvent("DELETE", "/v1/account", serviceHeaders));
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual(serviceTokenRejection);
  });

  it("lets a disabled owner retry self-delete without reopening other routes", async () => {
    stubAccountDeletionDependencies();
    const accountSecret = "fp_acct_retry";
    const disabledAccount = {
      ...fakeAccount(),
      secretHash: hashAccountSecret(accountSecret),
      status: "disabled" as const,
    };
    let disableCalls = 0;
    setCoreStoreForTests(createFakeStorage({
      accounts: {
        async getBySecretHash(secretHash: string) {
          return secretHash === disabledAccount.secretHash ? disabledAccount : null;
        },
        async disable(accountId: string) {
          expect(accountId).toBe(disabledAccount.accountId);
          disableCalls += 1;
          return null;
        },
      },
    }));
    const headers = { authorization: `Bearer ${accountSecret}` };

    const normalResponse = await handler(createEvent("GET", "/missing", headers));
    expect(normalResponse.status).toBe(401);

    const retryResponse = await handler(createEvent("DELETE", "/v1/account", headers));
    expect(retryResponse.status).toBe(200);
    expect(await responseJson(retryResponse)).toEqual(successfulDeletionResponse());
    expect(disableCalls).toBe(0);
  });

  it("keeps admin deletion available for an already-disabled account", async () => {
    stubAccountDeletionDependencies();
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    const disabledAccount = { ...fakeAccount(), status: "disabled" as const };
    let disableCalls = 0;
    setCoreStoreForTests(createFakeStorage({
      accounts: {
        async getById(accountId: string) {
          return accountId === disabledAccount.accountId ? disabledAccount : null;
        },
        async disable(accountId: string) {
          expect(accountId).toBe(disabledAccount.accountId);
          disableCalls += 1;
          return null;
        },
      },
    }));

    const response = await handler(createEvent("DELETE", `/accounts/${disabledAccount.accountId}`, {
      authorization: "Bearer admin-secret",
    }));

    expect(response.status).toBe(200);
    expect(await responseJson(response)).toEqual(successfulDeletionResponse());
    expect(disableCalls).toBe(0);
  });
});

async function responseJson(response: Response): Promise<unknown> {
  expect(response.headers.get("content-type")).toBe("application/json");
  return response.json();
}

function createEvent(
  method: string,
  rawPath: string,
  headers: Record<string, string> = {},
  body?: unknown,
): CoreRequest {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return {
    method,
    path: rawPath,
    search: "",
    query: new URLSearchParams(),
    headers: lower,
    body: body === undefined ? "" : JSON.stringify(body),
    cookies: [],
    clientIp: "127.0.0.1",
  };
}

function fakeAccount() {
  return {
    accountId: "acct_test",
    username: "company-a",
    description: "Company A account",
    secretHash: "hash",
    status: "active" as const,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function fakeAgent(overrides: Partial<{ status: "active" | "disabled" }> = {}) {
  return {
    accountId: "acct_test",
    agentId: "agent_main",
    name: "Main",
    status: overrides.status ?? "active",
    config: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
  };
}

function createFakeStorage(overrides: Record<string, unknown>) {
  return {
    accounts: {
      async getById() { return fakeAccount(); },
      async getBySecretHash() { return null; },
      async list() { return [fakeAccount()]; },
      async create() { return { account: fakeAccount(), secret: "fp_acct_fake" }; },
      async update() { return fakeAccount(); },
      async rotateSecret() { return { account: fakeAccount(), secret: "fp_acct_fake" }; },
      async remove() { return true; },
      ...(overrides.accounts as Record<string, unknown> | undefined),
      ...(!("accounts" in overrides) ? overrides : {}),
    },
    agents: {
      async getById() { return fakeAgent(); },
      async removeAllForAccount() { return 0; },
      ...(overrides.agents as Record<string, unknown> | undefined),
    },
    crons: {
      async list() { return []; },
      async create() { throw new Error("not implemented"); },
      ...(overrides.crons as Record<string, unknown> | undefined),
    },
    agentDeployments: {
      async getByApiKeyHash() { return null; },
      ...(overrides.agentDeployments as Record<string, unknown> | undefined),
    },
    sandboxConfigs: {
      async removeAllForAccount() { return 0; },
    },
    workspaceConfigs: {
      async list() { return []; },
      async removeAllForAccount() { return 0; },
    },
    accountTools: {
      async removeAllForAccount() { return 0; },
    },
    accountHooks: {
      async removeAllForAccount() { return 0; },
    },
  } as never;
}

function stubAccountDeletionDependencies(): void {
  process.env.SKILLS_BUCKET_NAME = "test-skills";
  process.env.TOOL_BUNDLES_BUCKET_NAME = "test-tool-bundles";
  S3Client.prototype.send = mock(async () => ({ Contents: [], IsTruncated: false })) as never;
  runtimePersistence.mutation = mock(async (name) => {
    expect(name).toBe("deleteAccountRuntimeData");
    return {
      conversationsDeleted: 0,
      processedEventsDeleted: 0,
      asyncAgentResultDeleted: 0,
      asyncToolResultDeleted: 0,
      asyncToolGroupDeleted: 0,
      sandboxReservationDeleted: 0,
      totalDeleted: 0,
    };
  }) as never;
}

function successfulDeletionResponse() {
  return {
    deleted: true,
    cleanup: {
      conversationsDeleted: 0,
      processedEventsDeleted: 0,
      asyncAgentResultDeleted: 0,
      asyncToolResultDeleted: 0,
      asyncToolGroupDeleted: 0,
      sandboxReservationDeleted: 0,
      filesystemObjectsDeleted: 0,
      reservedSandboxesReleased: 0,
      agentsDeleted: 0,
      skillObjectsDeleted: 0,
      toolBundleObjectsDeleted: 0,
      cronsDeleted: 0,
      accountToolsDeleted: 0,
      accountHooksDeleted: 0,
    },
  };
}
