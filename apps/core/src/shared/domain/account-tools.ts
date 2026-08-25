/**
 * Account-owned custom tool metadata and upload validation.
 * Bundle bytes live in S3; this file owns the persisted record contract.
 */

import type { JSONSchema7 } from "ai";
import { createHash } from "node:crypto";
import { isPlainObject } from "../object.ts";

export type AccountToolStatus = "active" | "deleted";
export type AccountToolRuntime = "isolate" | "sandbox" | "http";

export interface AccountToolRecord {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  // Absent on `runtime: "http"` tools, which carry an endpoint instead of
  // executable bytes.
  bundleStorageKey?: string;
  sha256?: string;
  runtime: AccountToolRuntime;
  /** Endpoint tools only: the https URL every call POSTs its input to. */
  endpointUrl?: string;
  /**
   * Endpoint tools only: literal non-secret headers sent with every call.
   * Values may carry `${NAME}` references resolved against the agent's
   * per-tool config env at call time; secrets never live in this row.
   */
  endpointHeaders?: Record<string, string>;
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
  // Bundle tiers only.
  bundleStorageKey?: string;
  sha256?: string;
  runtime?: AccountToolRuntime;
  // Endpoint tools only.
  endpointUrl?: string;
  endpointHeaders?: Record<string, string>;
  defaultConfig?: Record<string, unknown>;
}

export interface UpdateAccountToolInput {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema7;
  bundleStorageKey?: string;
  sha256?: string;
  runtime?: AccountToolRuntime;
  endpointUrl?: string;
  endpointHeaders?: Record<string, string>;
  defaultConfig?: Record<string, unknown> | null;
}

export interface AccountToolUploadInput {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  bundle?: unknown;
  runtime?: unknown;
  endpointUrl?: unknown;
  endpointHeaders?: unknown;
  defaultConfig?: unknown;
}

export interface NormalizedAccountToolUpload {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema7;
  bundle?: string;
  sha256?: string;
  runtime?: AccountToolRuntime;
  endpointUrl?: string;
  endpointHeaders?: Record<string, string>;
  defaultConfig?: Record<string, unknown>;
}

export interface PublicAccountToolRecord {
  accountId: string;
  toolId: string;
  name: string;
  description: string;
  inputSchema: JSONSchema7;
  sha256?: string;
  runtime: AccountToolRuntime;
  endpointUrl?: string;
  endpointHeaders?: Record<string, string>;
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
  // Unreachable: http tools carry no bundle and are rejected before sizing.
  http: 1_000_000,
};
// Endpoint tools call out to user infrastructure, so plain http would send
// tool input — potentially customer data — in cleartext. Bounds mirror the
// Convex-side gate (packages/convex/model/accountTools.ts).
const MAX_ENDPOINT_HEADER_BYTES = 8 * 1024;
const MAX_ENDPOINT_HEADERS = 32;
const NODE_BUILTIN_IMPORT_PATTERN =
  /(?:import\s+(?:[\s\S]*?\s+from\s*)?["']node:|import\s*\(\s*["']node:)/;
const BARE_IMPORT_PATTERN =
  /(?:^|[\n;])\s*import\s+(?:[\s\S]*?\s+from\s*)?["'](?!\.{1,2}\/|\/|node:)[^"']+["']|import\s*\(\s*["'](?!\.{1,2}\/|\/|node:)[^"']+["']\s*\)/;
// Member reads only: a locally declared `process` method or export key is not
// the global (bundled zod ships one), and `typeof process` is a guarded probe.
const NODE_GLOBAL_MEMBER_PATTERN =
  /(?<![.\w$])(?:process|Buffer)\s*(?:\?\.|\.|\[)/;
// Web Streams are outside what isolate/runner/web-globals.mjs installs, so a
// bundle touching one — every bundle importing `ai` does — runs on sandbox.
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

  const declaredRuntime =
    value.runtime !== undefined ? normalizeRuntime(value.runtime) : undefined;

  if (value.bundle !== undefined) {
    if (declaredRuntime === "http") {
      throw new Error("tool.bundle must not be set for http tools");
    }
    result.bundle = normalizeBundle(value.bundle);
  } else if (options.requireBundle && declaredRuntime !== "http") {
    throw new Error("tool.bundle is required");
  }

  if (declaredRuntime !== undefined) {
    result.runtime = declaredRuntime;
  } else if (options.requireBundle && result.bundle !== undefined) {
    // Infer the tier only on create/full sync. A bundle-only PATCH keeps the
    // stored runtime so it cannot silently flip an explicitly chosen tier.
    result.runtime = inferAccountToolRuntime(result.bundle);
  }
  const effectiveRuntime = result.runtime ?? options.currentRuntime;

  if (effectiveRuntime === "http") {
    if (result.bundle !== undefined) {
      throw new Error("tool.bundle must not be set for http tools");
    }
    if (value.endpointUrl !== undefined || options.requireBundle) {
      result.endpointUrl = normalizeEndpointUrl(value.endpointUrl);
    }
    if (value.endpointHeaders !== undefined) {
      result.endpointHeaders = normalizeEndpointHeaders(value.endpointHeaders);
    } else if (options.requireBundle) {
      result.endpointHeaders = {};
    }
  } else if (
    value.endpointUrl !== undefined ||
    value.endpointHeaders !== undefined
  ) {
    throw new Error(
      "tool.endpointUrl and tool.endpointHeaders are only valid for http tools",
    );
  }

  // Bound by the tier it will run on — the stored one on a bundle-only PATCH,
  // which deliberately does not restate runtime. Checked before hashing.
  if (result.bundle !== undefined) {
    assertBundleSize(
      result.bundle,
      effectiveRuntime ?? inferAccountToolRuntime(result.bundle),
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
  const runtime = input.runtime ? normalizeRuntime(input.runtime) : "sandbox";

  return {
    name: normalizeToolName(input.name),
    description: normalizeDescription(input.description),
    inputSchema: normalizeInputSchema(input.inputSchema),
    ...(runtime === "http"
      ? {
          runtime: runtime,
          endpointUrl: normalizeEndpointUrl(input.endpointUrl),
          ...(input.endpointHeaders !== undefined
            ? { endpointHeaders: normalizeEndpointHeaders(input.endpointHeaders) }
            : {}),
        }
      : {
          runtime: runtime,
          bundleStorageKey: normalizeStorageKey(input.bundleStorageKey),
          sha256: normalizeSha256(input.sha256),
        }),
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
  if (input.endpointUrl !== undefined)
    patch.endpointUrl = normalizeEndpointUrl(input.endpointUrl);
  if (input.endpointHeaders !== undefined)
    patch.endpointHeaders = normalizeEndpointHeaders(input.endpointHeaders);
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
    ...(record.sha256 !== undefined ? { sha256: record.sha256 } : {}),
    runtime: record.runtime,
    ...(record.endpointUrl !== undefined
      ? { endpointUrl: record.endpointUrl }
      : {}),
    ...(record.endpointHeaders !== undefined
      ? { endpointHeaders: record.endpointHeaders }
      : {}),
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
  if (value === "isolate" || value === "sandbox" || value === "http") {
    return value;
  }

  throw new Error('tool.runtime must be "isolate", "sandbox" or "http"');
}

/**
 * Validate an endpoint tool's https URL.
 * @param value raw endpointUrl field from the upload body
 * @returns the trimmed URL
 * @throws when the value is not an https URL
 */
function normalizeEndpointUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("tool.endpointUrl must be a string");
  }
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("tool.endpointUrl must be a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("tool.endpointUrl must use https");
  }

  return url;
}

/**
 * Validate an endpoint tool's static header set.
 * @param value raw endpointHeaders field from the upload body
 * @returns a copy keyed by header name
 * @throws when the value is not a bounded name → value string record
 */
function normalizeEndpointHeaders(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) {
    throw new Error("tool.endpointHeaders must be an object");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_ENDPOINT_HEADERS) {
    throw new Error(
      `tool.endpointHeaders must contain at most ${MAX_ENDPOINT_HEADERS} headers`,
    );
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (typeof name !== "string" || !/^[!-9;-~]+$/.test(name)) {
      throw new Error("tool.endpointHeaders keys must be header names");
    }
    if (typeof headerValue !== "string") {
      throw new Error(`tool.endpointHeaders.${name} must be a string`);
    }
    headers[name] = headerValue;
  }
  if (
    Buffer.byteLength(JSON.stringify(headers), "utf8") >
    MAX_ENDPOINT_HEADER_BYTES
  ) {
    throw new Error(
      `tool.endpointHeaders must be ${MAX_ENDPOINT_HEADER_BYTES} bytes or smaller`,
    );
  }

  return headers;
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
