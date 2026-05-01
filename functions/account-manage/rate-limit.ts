/**
 * Account-management request throttles.
 * Keep endpoint-specific abuse controls here, separate from account persistence.
 */

import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import type { LambdaFunctionURLEvent } from "aws-lambda";
import { createHash } from "node:crypto";
import { dynamo, isConditionalCheckFailed } from "../_shared/dynamo.ts";
import { optionalEnv, requireEnv } from "../_shared/env.ts";

const SIGNUP_WINDOW_SECONDS = 60 * 60;
const DEFAULT_SIGNUP_LIMIT = 5;

export class RateLimitExceededError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Rate limit exceeded");
    this.name = "RateLimitExceededError";
  }
}

export async function enforceAccountSignupRateLimit(event: LambdaFunctionURLEvent): Promise<void> {
  const limit = signupLimit();
  if (limit <= 0) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / SIGNUP_WINDOW_SECONDS) * SIGNUP_WINDOW_SECONDS;
  const retryAfterSeconds = windowStart + SIGNUP_WINDOW_SECONDS - now;

  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: requireEnv("ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME"),
      Key: {
        rateLimitKey: { S: `account-signup:${sourceHash(event)}:${windowStart}` },
      },
      UpdateExpression: [
        "SET createdAt = if_not_exists(createdAt, :createdAt),",
        "expiresAt = if_not_exists(expiresAt, :expiresAt)",
        "ADD attempts :one",
      ].join(" "),
      ConditionExpression: "attribute_not_exists(attempts) OR attempts < :limit",
      ExpressionAttributeValues: {
        ":createdAt": { S: new Date(now * 1000).toISOString() },
        ":expiresAt": { N: String(windowStart + (SIGNUP_WINDOW_SECONDS * 2)) },
        ":limit": { N: String(limit) },
        ":one": { N: "1" },
      },
    }));
  } catch (err) {
    if (isConditionalCheckFailed(err)) {
      throw new RateLimitExceededError(retryAfterSeconds);
    }
    throw err;
  }
}

function signupLimit(): number {
  const raw = optionalEnv("ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR");
  if (!raw) {
    return DEFAULT_SIGNUP_LIMIT;
  }

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR must be an integer");
  }

  return parsed;
}

function sourceHash(event: LambdaFunctionURLEvent): string {
  const sourceIp = event.requestContext.http.sourceIp || "unknown";
  return createHash("sha256").update(sourceIp).digest("hex").slice(0, 32);
}
