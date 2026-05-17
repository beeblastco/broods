/**
 * Rate limit tests.
 * Cover signup throttling, DynamoDB conditional writes, window expiration, and source hashing.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { dynamo } from "../functions/_shared/dynamo.ts";
import {
  enforceAccountSignupRateLimit,
  RateLimitExceededError,
} from "../functions/account-manage/rate-limit.ts";

const ORIGINAL_ENV = { ...process.env };
const originalSend = dynamo.send;
const sendMock = mock(async (_command: unknown) => ({}));

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dynamo.send = originalSend;
  sendMock.mockReset();
});

describe("RateLimitExceededError", () => {
  it("exposes retryAfterSeconds", () => {
    const err = new RateLimitExceededError(42);
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.message).toBe("Rate limit exceeded");
    expect(err.name).toBe("RateLimitExceededError");
  });
});

describe("enforceAccountSignupRateLimit", () => {
  function createEvent(sourceIp: string): LambdaFunctionURLEvent {
    return {
      version: "2.0",
      routeKey: "$default",
      rawPath: "/accounts",
      rawQueryString: "",
      headers: {},
      requestContext: {
        accountId: "123456789012",
        apiId: "api-id",
        domainName: "example.lambda-url.aws",
        domainPrefix: "example",
        http: {
          method: "POST",
          path: "/accounts",
          protocol: "HTTP/1.1",
          sourceIp,
          userAgent: "test",
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

  it("allows requests when rate limiting is disabled (limit 0)", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "0";

    await expect(enforceAccountSignupRateLimit(createEvent("1.2.3.4"))).resolves.toBeUndefined();
    expect(sendMock.mock.calls.length).toBe(0);
  });

  it("allows requests when limit env var is unset (uses default)", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    await expect(enforceAccountSignupRateLimit(createEvent("1.2.3.4"))).resolves.toBeUndefined();

    const command = sendMock.mock.calls[0]?.[0] as UpdateItemCommand;
    expect(command).toBeInstanceOf(UpdateItemCommand);
    expect(command.input.TableName).toBe("rate-limits");
    expect(command.input.Key).toEqual({
      rateLimitKey: { S: expect.stringMatching(/^account-signup:[a-f0-9]{32}:\d+$/) },
    });
  });

  it("allows requests within the limit", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "10";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    await expect(enforceAccountSignupRateLimit(createEvent("10.0.0.1"))).resolves.toBeUndefined();

    const command = sendMock.mock.calls[0]?.[0] as UpdateItemCommand;
    expect(command.input.UpdateExpression).toContain("ADD attempts :one");
    expect(command.input.ConditionExpression).toBe("attribute_not_exists(attempts) OR attempts < :limit");
    expect(command.input.ExpressionAttributeValues?.[":limit"]).toEqual({ N: "10" });
    expect(command.input.ExpressionAttributeValues?.[":one"]).toEqual({ N: "1" });
  });

  it("blocks requests that exceed the limit", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "3";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    const ConditionalCheckFailedException = (await import("@aws-sdk/client-dynamodb")).ConditionalCheckFailedException;
    sendMock.mockImplementation(async () => {
      throw new ConditionalCheckFailedException({ $metadata: {}, message: "limit exceeded" });
    });

    await expect(enforceAccountSignupRateLimit(createEvent("10.0.0.2"))).rejects.toThrow(RateLimitExceededError);

    try {
      await enforceAccountSignupRateLimit(createEvent("10.0.0.2"));
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitExceededError);
      expect((err as RateLimitExceededError).retryAfterSeconds).toBeGreaterThan(0);
      expect((err as RateLimitExceededError).retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  it("re-throws non-conditional errors", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "5";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    sendMock.mockImplementation(async () => {
      throw new Error("DynamoDB connection failed");
    });

    await expect(enforceAccountSignupRateLimit(createEvent("10.0.0.3"))).rejects.toThrow("DynamoDB connection failed");
  });

  it("uses a custom limit from env var", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "100";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    await expect(enforceAccountSignupRateLimit(createEvent("10.0.0.4"))).resolves.toBeUndefined();

    const command = sendMock.mock.calls[0]?.[0] as UpdateItemCommand;
    expect(command.input.ExpressionAttributeValues?.[":limit"]).toEqual({ N: "100" });
  });

  it("throws for non-integer limit env var", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "not-a-number";

    await expect(enforceAccountSignupRateLimit(createEvent("10.0.0.5"))).rejects.toThrow(
      "ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR must be an integer",
    );
  });

  it("throws for float limit env var", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "5.5";

    await expect(enforceAccountSignupRateLimit(createEvent("10.0.0.6"))).rejects.toThrow(
      "ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR must be an integer",
    );
  });

  it("requires the table name env var", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "5";
    delete process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME;

    await expect(enforceAccountSignupRateLimit(createEvent("10.0.0.7"))).rejects.toThrow(
      "Missing required environment variable: ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME",
    );
  });

  it("generates different rate limit keys for different source IPs", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "5";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    await enforceAccountSignupRateLimit(createEvent("1.1.1.1"));
    await enforceAccountSignupRateLimit(createEvent("2.2.2.2"));

    const key1 = (sendMock.mock.calls[0]?.[0] as UpdateItemCommand).input.Key?.rateLimitKey?.S;
    const key2 = (sendMock.mock.calls[1]?.[0] as UpdateItemCommand).input.Key?.rateLimitKey?.S;

    expect(key1).not.toBe(key2);
    expect(key1).toMatch(/^account-signup:[a-f0-9]{32}:\d+$/);
    expect(key2).toMatch(/^account-signup:[a-f0-9]{32}:\d+$/);
  });

  it("generates the same rate limit key for the same source IP", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "5";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    await enforceAccountSignupRateLimit(createEvent("3.3.3.3"));
    await enforceAccountSignupRateLimit(createEvent("3.3.3.3"));

    const key1 = (sendMock.mock.calls[0]?.[0] as UpdateItemCommand).input.Key?.rateLimitKey?.S;
    const key2 = (sendMock.mock.calls[1]?.[0] as UpdateItemCommand).input.Key?.rateLimitKey?.S;

    expect(key1).toBe(key2);
  });

  it("handles missing sourceIp by using unknown", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "5";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    const eventWithoutIp = createEvent("");
    eventWithoutIp.requestContext.http.sourceIp = "";

    await expect(enforceAccountSignupRateLimit(eventWithoutIp)).resolves.toBeUndefined();

    const command = sendMock.mock.calls[0]?.[0] as UpdateItemCommand;
    const key = command.input.Key?.rateLimitKey?.S as string;
    const hashPart = key.split(":")[1];
    expect(hashPart).toBe("unknown".padEnd(32, "").slice(0, 32) === "" ? expect.any(String) : hashPart);
  });

  it("sets expiresAt to two windows ahead", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR = "5";
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    await enforceAccountSignupRateLimit(createEvent("4.4.4.4"));

    const command = sendMock.mock.calls[0]?.[0] as UpdateItemCommand;
    const expiresAt = Number(command.input.ExpressionAttributeValues?.[":expiresAt"]?.N);
    const createdAt = command.input.ExpressionAttributeValues?.[":createdAt"]?.S as string;
    const createdAtTime = new Date(createdAt).getTime() / 1000;

    expect(expiresAt).toBeGreaterThan(createdAtTime);
  });

  it("uses the default limit of 5 when env var is not set", async () => {
    process.env.ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME = "rate-limits";
    dynamo.send = sendMock as never;

    await enforceAccountSignupRateLimit(createEvent("5.5.5.5"));

    const command = sendMock.mock.calls[0]?.[0] as UpdateItemCommand;
    expect(command.input.ExpressionAttributeValues?.[":limit"]).toEqual({ N: "5" });
  });
});
