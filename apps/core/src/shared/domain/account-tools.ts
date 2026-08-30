/**
 * Account-owned custom tool metadata and record validation.
 * Bundle bytes live in S3; this file owns the persisted record contract. The
 * upload normalizer, tier classifier, and bundle storage key live in the
 * config plane (packages/convex/model/accountTools.ts) and are re-exported
 * here.
 */

import type { AccountToolRuntime } from "@broods/convex/model/accountTools";
import type { JSONSchema7 } from "ai";
import { isPlainObject } from "../object.ts";

export type { AccountToolRuntime } from "@broods/convex/model/accountTools";
export {
  accountToolBundleStorageKey,
  inferAccountToolRuntime,
  normalizeAccountToolUpload,
} from "@broods/convex/model/accountTools";

export type AccountToolStatus = "active" | "deleted";

export interface AccountToolRecord {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  bundleStorageKey: string;
  sha256: string;
  runtime: AccountToolRuntime;
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
  runtime?: AccountToolRuntime;
  defaultConfig?: Record<string, unknown>;
}

export interface UpdateAccountToolInput {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema7;
  bundleStorageKey?: string;
  sha256?: string;
  runtime?: AccountToolRuntime;
  defaultConfig?: Record<string, unknown> | null;
}

export interface PublicAccountToolRecord {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  sha256: string;
  runtime: AccountToolRuntime;
  defaultConfig?: Record<string, unknown>;
  status: AccountToolStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

const MODEL_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CONVEX_DOCUMENT_ID_PATTERN = /^[a-z0-9]{20,}$/;

/** Returns whether a value has the documented native Convex document-id shape. */
export function isConvexDocumentId(value: string): boolean {
  return CONVEX_DOCUMENT_ID_PATTERN.test(value);
}

export function normalizeCreateAccountToolInput(
  input: CreateAccountToolInput,
): CreateAccountToolInput {
  return {
    name: normalizeToolName(input.name),
    description: normalizeDescription(input.description),
    inputSchema: normalizeInputSchema(input.inputSchema),
    bundleStorageKey: normalizeStorageKey(input.bundleStorageKey),
    sha256: normalizeSha256(input.sha256),
    runtime: input.runtime ? normalizeRuntime(input.runtime) : "sandbox",
    ...(input.defaultConfig !== undefined
      ? { defaultConfig: normalizeDefaultConfig(input.defaultConfig) }
      : {}),
  };
}

export function normalizeUpdateAccountToolInput(
  input: UpdateAccountToolInput,
): UpdateAccountToolInput {
  const patch: UpdateAccountToolInput = {};
  if (input.name !== undefined) patch.name = normalizeToolName(input.name);
  if (input.description !== undefined)
    patch.description = normalizeDescription(input.description);
  if (input.inputSchema !== undefined)
    patch.inputSchema = normalizeInputSchema(input.inputSchema);
  if (input.bundleStorageKey !== undefined)
    patch.bundleStorageKey = normalizeStorageKey(input.bundleStorageKey);
  if (input.sha256 !== undefined) patch.sha256 = normalizeSha256(input.sha256);
  if (input.runtime !== undefined)
    patch.runtime = normalizeRuntime(input.runtime);
  if (input.defaultConfig !== undefined) {
    patch.defaultConfig =
      input.defaultConfig === null
        ? null
        : normalizeDefaultConfig(input.defaultConfig);
  }

  return patch;
}

export function toPublicAccountTool(
  record: AccountToolRecord,
): PublicAccountToolRecord {
  return {
    accountId: record.accountId,
    toolId: record.toolId,
    name: record.name,
    description: record.description,
    inputSchema: record.inputSchema,
    sha256: record.sha256,
    runtime: record.runtime,
    ...(record.defaultConfig !== undefined
      ? { defaultConfig: record.defaultConfig }
      : {}),
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
    throw new Error(
      "tool.name must start with a letter or underscore and contain only letters, numbers, underscores, or hyphens",
    );
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
  if (
    schema.type !== undefined &&
    typeof schema.type !== "string" &&
    !Array.isArray(schema.type)
  ) {
    throw new Error("tool.inputSchema.type must be a string or array");
  }

  return schema;
}

function normalizeDefaultConfig(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("tool.defaultConfig must be an object");
  }

  return value as Record<string, unknown>;
}

function normalizeRuntime(value: unknown): AccountToolRuntime {
  if (value === "isolate" || value === "sandbox") return value;
  throw new Error('tool.runtime must be "isolate" or "sandbox"');
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
