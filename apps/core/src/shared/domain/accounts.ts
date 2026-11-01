import { ACCOUNT_KEY_PREFIX } from "@broods/convex/model/accountSecrets";
import { createHash, randomBytes } from "node:crypto";
import { isPlainObject } from "../object.ts";

export type AccountStatus = "active" | "disabled";

export interface AccountRecord {
  accountId: string;
  username: string;
  description?: string;
  secretHash: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  username: string;
  description?: string;
}

export function createAccountId(): string {
  return `acct_${randomBytes(12).toString("hex")}`;
}

export function createAccountSecret(): string {
  return `${ACCOUNT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashAccountSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function normalizeCreateAccountInput(
  value: unknown,
): CreateAccountInput {
  if (!isPlainObject(value))
    throw new Error("Request body must include username");
  if ("config" in value)
    throw new Error("Agent config is created through /v1/agents");
  const username = requireString(value.username, "username");
  const description = optionalString(value.description, "description");

  return {
    username: username,
    ...(description ? { description: description } : {}),
  };
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value.trim();
}
