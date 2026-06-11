/**
 * Account-owned custom tool metadata and upload validation.
 * Bundle bytes live in S3; this file owns the persisted record contract.
 */

import type { JSONSchema7 } from "ai";
import { createHash, randomBytes } from "node:crypto";

export type AccountToolStatus = "active" | "deleted";

export interface AccountToolRecord {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  bundleStorageKey: string;
  sha256: string;
  defaultConfig?: Record<string, unknown>;
  status: AccountToolStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface CreateAccountToolInput {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  bundleStorageKey: string;
  sha256: string;
  defaultConfig?: Record<string, unknown>;
}

export interface UpdateAccountToolInput {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema7;
  bundleStorageKey?: string;
  sha256?: string;
  defaultConfig?: Record<string, unknown> | null;
}

export interface AccountToolUploadInput {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  bundle?: unknown;
  defaultConfig?: unknown;
}

export interface NormalizedAccountToolUpload {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema7;
  bundle?: string;
  sha256?: string;
  defaultConfig?: Record<string, unknown>;
}

export interface PublicAccountToolRecord {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  sha256: string;
  defaultConfig?: Record<string, unknown>;
  status: AccountToolStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

const MODEL_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const MAX_BUNDLE_BYTES = 512 * 1024;

export function createAccountToolId(): string {
  return `tool_${randomBytes(12).toString("hex")}`;
}

export function normalizeAccountToolUpload(input: unknown, options: { requireBundle: boolean }): NormalizedAccountToolUpload {
  if (!isPlainObject(input)) {
    throw new Error("tool upload body must be an object");
  }

  const value = input as AccountToolUploadInput;
  const result: Partial<NormalizedAccountToolUpload> = {};

  if (value.name !== undefined) {
    result.name = normalizeToolName(value.name);
  } else if (options.requireBundle) {
    throw new Error("tool.name is required");
  }

  if (value.description !== undefined) {
    result.description = normalizeDescription(value.description);
  } else if (options.requireBundle) {
    throw new Error("tool.description is required");
  }

  if (value.inputSchema !== undefined) {
    result.inputSchema = normalizeInputSchema(value.inputSchema);
  } else if (options.requireBundle) {
    throw new Error("tool.inputSchema is required");
  }

  if (value.bundle !== undefined) {
    result.bundle = normalizeBundle(value.bundle);
    result.sha256 = sha256Hex(result.bundle);
  } else if (options.requireBundle) {
    throw new Error("tool.bundle is required");
  }

  if (value.defaultConfig !== undefined) {
    result.defaultConfig = normalizeDefaultConfig(value.defaultConfig);
  }

  return result as NormalizedAccountToolUpload;
}

export function normalizeCreateAccountToolInput(input: CreateAccountToolInput): CreateAccountToolInput {
  return {
    name: normalizeToolName(input.name),
    description: normalizeDescription(input.description),
    inputSchema: normalizeInputSchema(input.inputSchema),
    bundleStorageKey: normalizeStorageKey(input.bundleStorageKey),
    sha256: normalizeSha256(input.sha256),
    ...(input.defaultConfig !== undefined ? { defaultConfig: normalizeDefaultConfig(input.defaultConfig) } : {}),
  };
}

export function normalizeUpdateAccountToolInput(input: UpdateAccountToolInput): UpdateAccountToolInput {
  const patch: UpdateAccountToolInput = {};
  if (input.name !== undefined) patch.name = normalizeToolName(input.name);
  if (input.description !== undefined) patch.description = normalizeDescription(input.description);
  if (input.inputSchema !== undefined) patch.inputSchema = normalizeInputSchema(input.inputSchema);
  if (input.bundleStorageKey !== undefined) patch.bundleStorageKey = normalizeStorageKey(input.bundleStorageKey);
  if (input.sha256 !== undefined) patch.sha256 = normalizeSha256(input.sha256);
  if (input.defaultConfig !== undefined) {
    patch.defaultConfig = input.defaultConfig === null ? null : normalizeDefaultConfig(input.defaultConfig);
  }
  return patch;
}

export function accountToolBundleStorageKey(accountId: string, sha256: string): string {
  return `account-tools/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
}

export function toPublicAccountTool(record: AccountToolRecord): PublicAccountToolRecord {
  return {
    accountId: record.accountId,
    toolId: record.toolId,
    name: record.name,
    description: record.description,
    inputSchema: record.inputSchema,
    sha256: record.sha256,
    ...(record.defaultConfig !== undefined ? { defaultConfig: record.defaultConfig } : {}),
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.deletedAt ? { deletedAt: record.deletedAt } : {}),
  };
}

function normalizeToolName(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("tool.name must be a non-empty string");
  }
  const name = value.trim();
  if (!MODEL_TOOL_NAME_PATTERN.test(name)) {
    throw new Error("tool.name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens");
  }
  return name;
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("tool.description must be a non-empty string");
  }
  return value.trim();
}

function normalizeInputSchema(value: unknown): JSONSchema7 {
  if (!isPlainObject(value)) {
    throw new Error("tool.inputSchema must be a JSON Schema object");
  }
  const schema = value as JSONSchema7;
  if (schema.type !== undefined && typeof schema.type !== "string" && !Array.isArray(schema.type)) {
    throw new Error("tool.inputSchema.type must be a string or array");
  }
  return schema;
}

function normalizeBundle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("tool.bundle must be a non-empty string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_BUNDLE_BYTES) {
    throw new Error(`tool.bundle must be ${MAX_BUNDLE_BYTES} bytes or smaller`);
  }
  return value;
}

function normalizeDefaultConfig(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("tool.defaultConfig must be an object");
  }
  return value as Record<string, unknown>;
}

function normalizeStorageKey(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("tool.bundleStorageKey must be a non-empty string");
  }
  return value;
}

function normalizeSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("tool.sha256 must be a hex sha256");
  }
  return value;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
