import { afterEach, describe, expect, it } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { handler } from "../functions/account-manage/handler.ts";
import type { LambdaResponse } from "../functions/_shared/runtime.ts";
import { resetStorageForTests, setStorageForTests } from "../functions/_shared/storage/index.ts";

const originalAdminSecret = process.env.ADMIN_ACCOUNT_SECRET;
const originalSignupLimit = process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR;
const originalServiceSecret = process.env.SERVICE_AUTH_SECRET;
const originalCronsTable = process.env.CRONS_TABLE_NAME;
const originalSchedulerRoleArn = process.env.CRON_SCHEDULER_ROLE_ARN;
const originalSchedulerTargetArn = process.env.CRON_SCHEDULER_TARGET_FUNCTION_ARN;
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
    delete process.env.CRON_SCHEDULER_TARGET_FUNCTION_ARN;
  } else {
    process.env.CRON_SCHEDULER_TARGET_FUNCTION_ARN = originalSchedulerTargetArn;
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

    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual({ status: "ok" });
  });

  it("returns JSON errors for missing auth", async () => {
    const response = await handler(createEvent("GET", "/accounts/me"));

    expect(response.statusCode).toBe(401);
    expect(responseJson(response)).toEqual({ error: "Unauthorized" });
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

    expect(response.statusCode).toBe(201);
    expect(responseJson(response)).toEqual({
      account: {
        accountId: "acct_test",
        username: "company-a",
        description: "Company A account",
      },
      secret: "fp_acct_created",
    });
  });

  it("returns rotated one-time secret as secret", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    setStorageForTests(createFakeStorage({
      async rotateSecret() {
        return {
          account: fakeAccount(),
          secret: "fp_acct_rotated",
        };
      },
    }));

    const response = await handler(createEvent("POST", "/accounts/acct_test/rotate-secret", {
      authorization: "Bearer admin-secret",
    }));

    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual({
      account: {
        accountId: "acct_test",
        username: "company-a",
        description: "Company A account",
        status: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      },
      secret: "fp_acct_rotated",
    });
  });

  it("returns JSON not found errors for authenticated admin requests", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    const response = await handler(createEvent("GET", "/missing", {
      authorization: "Bearer admin-secret",
    }));

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toEqual({ error: "Not found" });
  });

  it("reports cron routes as unavailable when scheduler env is missing", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    delete process.env.CRONS_TABLE_NAME;
    const response = await handler(createEvent("GET", "/accounts/acct_test/crons", {
      authorization: "Bearer admin-secret",
    }));

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toEqual({ error: "Cron jobs are unavailable" });
  });

  it("allows service tokens on self cron, skill, and tool routes only", async () => {
    process.env.SERVICE_AUTH_SECRET = "service-secret";
    process.env.CRONS_TABLE_NAME = "crons";
    process.env.CRON_SCHEDULER_ROLE_ARN = "arn:aws:iam::123456789012:role/scheduler";
    process.env.CRON_SCHEDULER_TARGET_FUNCTION_ARN = "arn:aws:lambda:eu-central-1:123456789012:function:harness";
    process.env.CRON_SCHEDULER_GROUP_NAME = "cron-group";
    setStorageForTests(createFakeStorage({
      agents: {
        async getById() { return fakeAgent({ status: "active" }); },
      },
      crons: {
        async list() { return []; },
      },
    }));
    const serviceHeaders = {
      authorization: "Bearer service-secret",
      "x-account-id": "acct_test",
    };
    const serviceTokenRejection = { error: "Service token is not allowed for this account endpoint" };

    for (const path of [
      "/accounts/me",
      "/accounts/me/agents",
      "/accounts/me/sandboxes",
      "/accounts/me/workspaces",
    ]) {
      const response = await handler(createEvent("GET", path, serviceHeaders));
      expect(response.statusCode).toBe(400);
      expect(responseJson(response)).toEqual(serviceTokenRejection);
    }

    // Skill/tool sync routes accept the account-scoped service token (the Convex CLI
    // sync path); the request gets past auth (downstream listing may fail without S3,
    // but it is never the service-token rejection).
    for (const path of ["/accounts/me/skills", "/accounts/me/tools"]) {
      const response = await handler(createEvent("GET", path, serviceHeaders));
      expect(responseJson(response)).not.toEqual(serviceTokenRejection);
    }

    const cronResponse = await handler(createEvent("GET", "/accounts/me/crons", serviceHeaders));
    expect(cronResponse.statusCode).toBe(200);
    expect(responseJson(cronResponse)).toEqual({ crons: [] });
  });

  it("allows deployment runtime keys on self cron routes", async () => {
    process.env.CRONS_TABLE_NAME = "crons";
    process.env.CRON_SCHEDULER_ROLE_ARN = "arn:aws:iam::123456789012:role/scheduler";
    process.env.CRON_SCHEDULER_TARGET_FUNCTION_ARN = "arn:aws:lambda:eu-central-1:123456789012:function:harness";
    process.env.CRON_SCHEDULER_GROUP_NAME = "cron-group";
    setStorageForTests(createFakeStorage({
      crons: {
        async list(accountId: string) {
          return [{
            accountId: accountId,
            cronId: "cron_1",
            name: "Daily",
            agentId: "agent_main",
            events: [{ role: "user", content: [{ type: "text", text: "Run maintenance." }] }],
            scheduleExpression: "rate(1 day)",
            status: "active",
            schedulerName: "cron_1",
            schedulerGroupName: "cron-group",
            createdAt: "2026-05-01T00:00:00.000Z",
            updatedAt: "2026-05-01T00:00:00.000Z",
          }];
        },
      },
      agentDeployments: {
        async getByApiKeyHash() {
          return {
            accountId: "acct_test",
            endpointId: "env-endpoint",
            projectSlug: "demo",
            environmentSlug: "development",
          };
        },
      },
    }));

    const response = await handler(createEvent("GET", "/accounts/me/crons", {
      authorization: "Bearer fp_agent_test",
    }));

    expect(response.statusCode).toBe(200);
    expect(responseJson(response)).toEqual({
      crons: [{
        accountId: "acct_test",
        cronId: "cron_1",
        name: "Daily",
        agentId: "agent_main",
        events: [{ role: "user", content: [{ type: "text", text: "Run maintenance." }] }],
        scheduleExpression: "rate(1 day)",
        status: "active",
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.000Z",
      }],
    });
  });

  it("rejects cron jobs that reference inactive agents", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    process.env.CRONS_TABLE_NAME = "crons";
    process.env.CRON_SCHEDULER_ROLE_ARN = "arn:aws:iam::123456789012:role/scheduler";
    process.env.CRON_SCHEDULER_TARGET_FUNCTION_ARN = "arn:aws:lambda:eu-central-1:123456789012:function:harness";
    process.env.CRON_SCHEDULER_GROUP_NAME = "cron-group";
    setStorageForTests(createFakeStorage({
      agents: {
        async getById() { return fakeAgent({ status: "disabled" }); },
      },
      crons: {
        async create() {
          throw new Error("cron job should not be created for inactive agents");
        },
      },
    }));

    const response = await handler(createEvent("POST", "/accounts/acct_test/crons", {
      authorization: "Bearer admin-secret",
    }, {
      name: "Daily",
      agentId: "agent_main",
      input: "Run maintenance.",
      scheduleExpression: "rate(1 day)",
    }));

    expect(response.statusCode).toBe(400);
    expect(responseJson(response)).toEqual({ error: "Cron job agentId must reference an active agent" });
  });
});

function responseJson(response: LambdaResponse): unknown {
  expect(response.headers?.["Content-Type"]).toBe("application/json");
  return JSON.parse(String(response.body ?? "{}"));
}

function createEvent(
  method: string,
  rawPath: string,
  headers: Record<string, string> = {},
  body?: unknown,
): LambdaFunctionURLEvent {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath,
    rawQueryString: "",
    headers,
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.lambda-url.aws",
      domainPrefix: "example",
      http: {
        method,
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "bun-test",
      },
      requestId: "request-id",
      routeKey: "$default",
      stage: "$default",
      time: "01/May/2026:00:00:00 +0000",
      timeEpoch: 1777593600000,
    },
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
