import { afterEach, describe, expect, it } from "bun:test";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { handler } from "../functions/account-manage/handler.ts";
import type { LambdaResponse } from "../functions/_shared/runtime.ts";

const originalAdminSecret = process.env.ADMIN_ACCOUNT_SECRET;

afterEach(() => {
  if (originalAdminSecret === undefined) {
    delete process.env.ADMIN_ACCOUNT_SECRET;
  } else {
    process.env.ADMIN_ACCOUNT_SECRET = originalAdminSecret;
  }
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

  it("returns JSON not found errors for authenticated admin requests", async () => {
    process.env.ADMIN_ACCOUNT_SECRET = "admin-secret";
    const response = await handler(createEvent("GET", "/missing", {
      authorization: "Bearer admin-secret",
    }));

    expect(response.statusCode).toBe(404);
    expect(responseJson(response)).toEqual({ error: "Not found" });
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
  };
}
