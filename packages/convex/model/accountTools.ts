/**
 * Account-owned custom tool upload validation for Convex config-plane sync.
 * Mirrors core's account tool upload contract without requiring the Node runtime.
 */

import { isPlainObject } from "./objects";

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

/**
 * Execution tier for an uploaded tool: "isolate" runs in core's V8
 * isolate, "sandbox" delegates to the workdir sandbox provider, "http"
 * POSTs the tool input to a user-hosted endpoint.
 */
export type AccountToolRuntime = "isolate" | "sandbox" | "http";

export interface NormalizedAccountToolUpload {
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  bundle?: string;
  sha256?: string;
  runtime?: AccountToolRuntime;
  endpointUrl?: string;
  endpointHeaders?: Record<string, string>;
  defaultConfig?: Record<string, unknown>;
}

const MODEL_TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
// Matches the CLI's MAX_BUNDLE_FILE_BYTES so a bundle that passes CLI validation
// is not rejected at this upload gate — large enough for AI-SDK-derived tools.
// Mirrors core's per-tier bound (apps/core/src/shared/domain/account-tools.ts).
const MAX_BUNDLE_BYTES: Record<AccountToolRuntime, number> = {
  isolate: 1_000_000,
  sandbox: 10_000_000,
  // Unreachable: http tools carry no bundle and are rejected before sizing.
  http: 1_000_000,
};
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

/**
 * Normalize and validate a custom tool upload.
 * @param input upload object from the CLI manifest, HTTP API or dashboard
 * @param options whether the execution definition is required (create/full sync);
 *   `http` tools require `endpointUrl` instead of a bundle
 * @returns normalized fields with bundle sha256 when a bundle is present
 */
export async function normalizeAccountToolUpload(
  input: unknown,
  options: { requireBundle: boolean; currentRuntime?: AccountToolRuntime },
): Promise<NormalizedAccountToolUpload> {
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
    result.sha256 = await sha256Hex(result.bundle);
  }

  if (value.defaultConfig !== undefined) {
    result.defaultConfig = normalizeDefaultConfig(value.defaultConfig);
  }

  return result as NormalizedAccountToolUpload;
}

/** A create/full-sync normalization: name, description and schema are set. */
export interface FullToolUpload extends NormalizedAccountToolUpload {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Narrow a `requireBundle: true` normalization result for callers that persist
 * it — those three fields are guaranteed by the normalizer, but the merged
 * return type cannot say so.
 * @param upload result of `normalizeAccountToolUpload` with requireBundle true
 * @returns the same upload with creation-required fields non-optional
 */
export function requireFullToolUpload(
  upload: NormalizedAccountToolUpload,
): FullToolUpload {
  if (
    upload.name === undefined ||
    upload.description === undefined ||
    upload.inputSchema === undefined
  ) {
    throw new Error(
      "tool.name, tool.description and tool.inputSchema are required",
    );
  }

  return upload as FullToolUpload;
}

/**
 * Build the S3 object key used for an account tool bundle.
 * @param accountId account id owning the tool
 * @param sha256 hex sha256 of the bundle contents
 * @returns stable S3 key for the bundle object
 */
export function accountToolBundleStorageKey(
  accountId: string,
  sha256: string,
): string {
  return `account-tools/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
}

/**
 * Cheap upload-time heuristic for choosing the default execution tier. Bundles
 * that mention Node-only globals, node: imports, require(), bare package
 * imports, or Web Streams need the sandbox tier; everything the isolate's global
 * set covers stays on the faster isolate tier.
 * @param bundleSource bundled JavaScript module source
 * @returns the inferred runtime tier
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

function normalizeInputSchema(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("tool.inputSchema must be a JSON Schema object");
  }
  if (
    value.type !== undefined &&
    typeof value.type !== "string" &&
    !Array.isArray(value.type)
  ) {
    throw new Error("tool.inputSchema.type must be a string or array");
  }

  return value;
}

function assertBundleSize(bundle: string, runtime: AccountToolRuntime): void {
  const limit = MAX_BUNDLE_BYTES[runtime];
  if (new TextEncoder().encode(bundle).byteLength > limit) {
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

  return value;
}

/**
 * Validate an explicit runtime tier value from an upload.
 * @param value raw runtime field from the upload body
 * @returns the validated tier
 * @throws when the value is not "isolate", "sandbox" or "http"
 */
function normalizeRuntime(value: unknown): AccountToolRuntime {
  if (value === "isolate" || value === "sandbox" || value === "http") {
    return value;
  }

  throw new Error('tool.runtime must be "isolate", "sandbox" or "http"');
}

// Endpoint tools call out to user infrastructure, so plain http would send
// tool input — potentially customer data — in cleartext.
const MAX_ENDPOINT_HEADER_BYTES = 8 * 1024;
const MAX_ENDPOINT_HEADERS = 32;

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
    new TextEncoder().encode(JSON.stringify(headers)).byteLength >
    MAX_ENDPOINT_HEADER_BYTES
  ) {
    throw new Error(
      `tool.endpointHeaders must be ${MAX_ENDPOINT_HEADER_BYTES} bytes or smaller`,
    );
  }

  return headers;
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
