import { afterEach, describe, expect, it } from "bun:test";
import { handler } from "../src/accounts/handler.ts";
import type { CoreRequest } from "../src/shared/http.ts";
import { resetStorageForTests, setStorageForTests } from "../src/shared/storage/index.ts";

const originalAdminSecret = process.env.ADMIN_ACCOUNT_SECRET;
const originalSignupLimit = process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR;
const originalServiceSecret = process.env.SERVICE_AUTH_SECRET;
const originalCronsTable = process.env.CRONS_TABLE_NAME;
const originalSchedulerRoleArn = process.env.CRON_SCHEDULER_ROLE_ARN;
const originalSchedulerTargetArn = process.env.CRON_SCHEDULER_TARGET_ARN;
const originalSchedulerGroupName = process.env.CRON_SCHEDULER_GROUP_NAME;

afterEach(() => {
  if (originalAdminSecret === undefined) {
    delete process.env.ADMIN_ACCOUNT_SECRET;
  } else {
    process.env.ADMIN_ACCOUNT_SECRET = originalAdminSecret;
  }
  if (originalSignupLimit === undefined) {
    delete process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR;
  } else {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = originalSignupLimit;
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
  setStorageForTests(null);
  resetStorageForTests();
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

  it("returns create account one-time secret as secret", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "0";
    setStorageForTests(createFakeStorage({
      async create() {
        return {
          account: fakeAccount(),
          secret: "fp_acct_created",
        };
      },
    }));

    const response = await handler(createEvent("POST", "/accounts", {}, {
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
    setStorageForTests(createFakeStorage({}));

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
    setStorageForTests(createFakeStorage({}));

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
    setStorageForTests(createFakeStorage({}));
    const serviceHeaders = {
      authorization: "Bearer service-secret",
      "x-account-id": "acct_test",
    };
    const serviceTokenRejection = { error: "Service token is not allowed for this account endpoint" };

    const response = await handler(createEvent("DELETE", "/v1/account", serviceHeaders));
    expect(response.status).toBe(400);
    expect(await responseJson(response)).toEqual(serviceTokenRejection);
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
    kind: "fake",
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
    accountTools: {} as never,
  } as never;
}
