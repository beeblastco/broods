import { afterEach, describe, expect, it } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { handler } from "../functions/account-manage/handler.ts";
import type { LambdaResponse } from "../functions/_shared/runtime.ts";
import { resetStorageForTests, setStorageForTests } from "../functions/_shared/storage/index.ts";

const originalAdminSecret = process.env.ADMIN_ACCOUNT_SECRET;
const originalSignupLimit = process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR;

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
    delete process.env.CRON_JOBS_TABLE_NAME;
    const response = await handler(createEvent("GET", "/accounts/acct_test/cron-jobs", {
      authorization: "Bearer admin-secret",
    }));

    expect(response.statusCode).toBe(503);
    expect(responseJson(response)).toEqual({ error: "Cron jobs are unavailable" });
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

function createFakeStorage(accountOverrides: Record<string, unknown>) {
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
      ...accountOverrides,
    },
    agents: {} as never,
    cronJobs: {} as never,
  } as never;
}
