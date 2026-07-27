/**
 * Account-owned custom tool metadata and upload validation.
 * Bundle bytes live in S3; this file owns the persisted record contract.
 */

import type { JSONSchema7 } from "ai";
import { createHash } from "node:crypto";
import { isPlainObject } from "../object.ts";

export type AccountToolStatus = "active" | "deleted";
export type AccountToolRuntime = "isolate" | "sandbox";

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

export interface AccountToolUploadInput {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  bundle?: unknown;
  runtime?: unknown;
  defaultConfig?: unknown;
}

export interface NormalizedAccountToolUpload {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema7;
  bundle?: string;
  sha256?: string;
  runtime?: AccountToolRuntime;
  defaultConfig?: Record<string, unknown>;
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
// A sandbox bundle streams from S3 into the runner; an isolate bundle is inlined
// into core's own process, where every concurrent call holds a copy.
const MAX_BUNDLE_BYTES: Record<AccountToolRuntime, number> = {
  isolate: 1_000_000,
  sandbox: 10_000_000,
};
const NODE_BUILTIN_IMPORT_PATTERN =
  /(?:import\s+(?:[\s\S]*?\s+from\s*)?["']node:|import\s*\(\s*["']node:)/;
const BARE_IMPORT_PATTERN =
  /(?:^|[\n;])\s*import\s+(?:[\s\S]*?\s+from\s*)?["'](?!\.{1,2}\/|\/|node:)[^"']+["']|import\s*\(\s*["'](?!\.{1,2}\/|\/|node:)[^"']+["']\s*\)/;
// Reading a member off the Node globals throws in an isolate. Only the member
// forms count: a locally declared `process` method or export key is not the
// global (zod ships one), and `typeof process` is a guarded probe that is fine.
const NODE_GLOBAL_MEMBER_PATTERN =
  /(?<![.\w$])(?:process|Buffer)\s*(?:\?\.|\.|\[)/;
// Web Streams are outside what the isolate installs (isolate/runner/web-globals.mjs),
// so a bundle that touches one — every bundle importing `ai` does — runs on the
// sandbox tier rather than dying on a ReferenceError halfway through.
const WEB_STREAMS_PATTERN =
  /(?<![.\w$])(?:Readable|Writable|Transform)Stream\b/;
const CONVEX_DOCUMENT_ID_PATTERN = /^[a-z0-9]{20,}$/;

/** Returns whether a value has the documented native Convex document-id shape. */
export function isAccountToolId(value: string): boolean {
  return CONVEX_DOCUMENT_ID_PATTERN.test(value);
}

export function normalizeAccountToolUpload(
  input: unknown,
  options: { requireBundle: boolean; currentRuntime?: AccountToolRuntime },
): NormalizedAccountToolUpload {
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
  } else if (options.requireBundle) {
    throw new Error("tool.bundle is required");
  }

  if (value.runtime !== undefined) {
    result.runtime = normalizeRuntime(value.runtime);
  } else if (options.requireBundle && result.bundle !== undefined) {
    // Infer the tier only on create/full sync. A bundle-only PATCH keeps the
    // stored runtime so it cannot silently flip an explicitly chosen tier.
    result.runtime = inferAccountToolRuntime(result.bundle);
  }

  // Bound by the tier it will run on — the stored one on a bundle-only PATCH,
  // which deliberately does not restate runtime. Checked before hashing.
  if (result.bundle !== undefined) {
    assertBundleSize(
      result.bundle,
      result.runtime ??
        options.currentRuntime ??
        inferAccountToolRuntime(result.bundle),
    );
    result.sha256 = sha256Hex(result.bundle);
  }

  if (value.defaultConfig !== undefined) {
    result.defaultConfig = normalizeDefaultConfig(value.defaultConfig);
  }

  return result as NormalizedAccountToolUpload;
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

export function accountToolBundleStorageKey(
  accountId: string,
  sha256: string,
): string {
  return `account-tools/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
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

/**
 * Cheap upload-time heuristic for choosing the default execution tier. Bundles
 * that mention Node-only globals, node: imports, require(), bare package
 * imports, or Web Streams need the sandbox tier; everything the isolate's global
 * set covers stays on the faster isolate tier.
 */
export function inferAccountToolRuntime(
  bundleSource: string,
): AccountToolRuntime {
  if (
    /\brequire\s*\(/.test(bundleSource) ||
    NODE_BUILTIN_IMPORT_PATTERN.test(bundleSource) ||
    NODE_GLOBAL_MEMBER_PATTERN.test(bundleSource) ||
    WEB_STREAMS_PATTERN.test(bundleSource) ||
    /\b__dirname\b/.test(bundleSource) ||
    BARE_IMPORT_PATTERN.test(bundleSource)
  ) {
    return "sandbox";
  }
  return "isolate";
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

function assertBundleSize(bundle: string, runtime: AccountToolRuntime): void {
  const limit = MAX_BUNDLE_BYTES[runtime];
  if (Buffer.byteLength(bundle, "utf8") > limit) {
    throw new Error(
      `tool.bundle must be ${limit} bytes or smaller on the ${runtime} runtime`,
    );
  }
}

function normalizeBundle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("tool.bundle must be a non-empty string");
  }
  return value;
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
