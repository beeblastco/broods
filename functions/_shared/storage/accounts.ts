/**
 * Account types, id/secret/hash helpers, input normalization, and public
 * projection. Persistence lives in `./dynamo/accounts.ts` and
 * `./convex/index.ts` and is reached through `getStorage().accounts.*`.
 */

import { createHash, randomBytes } from "node:crypto";

const ACCOUNT_SECRET_PREFIX = "fp_acct_";

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

export interface PublicAccountRecord {
  accountId: string;
  username: string;
  description?: string;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  username: string;
  description?: string;
}

export interface UpdateAccountInput {
  username?: string;
  description?: string | null;
}

export function createAccountId(): string {
  return `acct_${randomBytes(12).toString("hex")}`;
}

export function createAccountSecret(): string {
  return `${ACCOUNT_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashAccountSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function toPublicAccount(account: AccountRecord): PublicAccountRecord {
  return {
    accountId: account.accountId,
    username: account.username,
    ...(account.description ? { description: account.description } : {}),
    status: account.status,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

export function normalizeCreateAccountInput(value: unknown): CreateAccountInput {
  if (!isPlainObject(value)) throw new Error("Request body must include username");
  if ("config" in value) throw new Error("Agent config is created through /accounts/me/agents");
  const username = requireString(value.username, "username");
  const description = optionalString(value.description, "description");
  return { username, ...(description ? { description } : {}) };
}

export function normalizeUpdateAccountInput(value: unknown): UpdateAccountInput {
  if (!isPlainObject(value)) throw new Error("Request body must be an object");
  if ("config" in value) throw new Error("Agent config must be updated through /accounts/me/agents/{agentId}");
  const v = value as Record<string, unknown>;
  const normalized: UpdateAccountInput = {
    ...(v.username !== undefined ? { username: requireString(v.username, "username") } : {}),
    ...(v.description !== undefined
      ? { description: v.description === null ? null : optionalString(v.description, "description") }
      : {}),
  };
  if (Object.keys(normalized).length === 0) {
    throw new Error("Request body must include username or description");
  }
  return normalized;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
