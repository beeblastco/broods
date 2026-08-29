/**
 * Shared validation for MCP server registrations (issue #331 phase 1). One
 * normalizer serves both write paths (CLI sync and dashboard) the way
 * `normalizeAccountToolUpload` does for tools. Rows describe an external MCP
 * server that core connects to over the stateless HTTP transport, spec
 * 2026-07-28 only. Auth header values may carry ${NAME} account env refs;
 * they resolve into the encrypted agent config at sync time, never on this
 * row, and credential-bearing headers must use one instead of an inline
 * secret.
 */

import { sha256Hex } from "./accountSecrets";
import { ACCOUNT_ENV_PLACEHOLDER_PATTERN } from "./envRefs";

/** Matches the uploaded-package ceiling from #190 (the sandbox tool cap). */
const MAX_BUNDLE_BYTES = 10_000_000;

const MAX_ALLOWED_TOOLS = 256;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_HEADERS = 16;
const MAX_HEADER_VALUE_LENGTH = 2048;
const MAX_URL_LENGTH = 2048;

/** RFC 9110 field-name token characters. */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;

/** Headers whose values carry credentials and so must use a ${NAME} ref. */
const SENSITIVE_HEADER_NAMES = new Set([
  "api-key",
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]);

/**
 * Server names become the `server__tool` namespace prefix inside provider
 * tool names, which allow only [A-Za-z0-9_-]. Underscores are excluded here
 * so the `__` separator stays unambiguous.
 */
const MCP_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Remote tool names, as constrained by the MCP spec's SHOULD plus our cap. */
const MCP_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type McpTransport = "http" | "hosted";

export interface McpInput {
  name?: string;
  description?: string;
  transport?: McpTransport;
  url?: string;
  /** Hosted-only: bundled server module source; sha256 derived from it. */
  bundle?: string;
  sha256?: string;
  headers?: Record<string, string>;
  allowedTools?: string[];
  disabled?: boolean;
}

/**
 * Build the S3 object key used for a hosted MCP server bundle. Keeping the
 * prefix separate from account-tools/ is what makes the phase 3 deletion and
 * the account-delete sweep (accounts/cleanup.ts) unambiguous.
 */
export function mcpBundleStorageKey(accountId: string, sha256: string): string {
  return `account-mcp/${encodeURIComponent(accountId)}/bundles/${sha256}.mjs`;
}

/**
 * Validate and normalize an MCP server create or patch body. With
 * `requireConnection` (POST) `name` plus a connection are mandatory: a `url`
 * makes an "http" row, a `bundle` makes a "hosted" one. A patch (PATCH) may
 * carry any subset. Unknown keys are ignored, matching the tolerance of the
 * other config-plane normalizers.
 */
export async function normalizeMcpInput(
  body: unknown,
  options: { requireConnection: boolean },
): Promise<McpInput> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object");
  }
  const record = body as Record<string, unknown>;
  const input: McpInput = {};
  if (record.name !== undefined) input.name = normalizeName(record.name);
  if (record.description !== undefined && record.description !== null) {
    input.description = normalizeDescription(record.description);
  }
  normalizeConnection(record, input);
  // Hash here (async: Convex's runtime only offers web crypto) so every
  // write path gets sha256 with the bundle instead of deriving it later.
  if (input.bundle !== undefined) {
    input.sha256 = await sha256Hex(input.bundle);
  }
  if (record.headers !== undefined && record.headers !== null) {
    input.headers = normalizeHeaders(record.headers);
  }
  if (record.allowedTools !== undefined && record.allowedTools !== null) {
    input.allowedTools = normalizeAllowedTools(record.allowedTools);
  }
  if (record.disabled !== undefined) {
    if (typeof record.disabled !== "boolean") {
      throw new Error("disabled must be a boolean");
    }
    input.disabled = record.disabled;
  }
  if (options.requireConnection) {
    if (input.name === undefined) throw new Error("name must be provided");
    if (input.url === undefined && input.bundle === undefined) {
      throw new Error("url must be provided, or bundle for a hosted server");
    }
  }

  return input;
}

function normalizeAllowedTools(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("allowedTools must be an array of tool names");
  }
  if (value.length > MAX_ALLOWED_TOOLS) {
    throw new Error(
      `allowedTools must list at most ${MAX_ALLOWED_TOOLS} tools`,
    );
  }
  const names = value as string[];
  for (const name of names) {
    if (!MCP_TOOL_NAME_PATTERN.test(name)) {
      throw new Error(
        `allowedTools entries must match ${MCP_TOOL_NAME_PATTERN}: ${name}`,
      );
    }
  }

  return names;
}

function normalizeBundle(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("bundle must be a non-empty string of module source");
  }
  // TextEncoder, not Buffer: this runs in Convex's V8 isolate too.
  if (new TextEncoder().encode(value).byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(`bundle must be at most ${MAX_BUNDLE_BYTES} bytes`);
  }

  return value;
}

/** A `url` makes an "http" row, a `bundle` a "hosted" one; never both. */
function normalizeConnection(
  record: Record<string, unknown>,
  input: McpInput,
): void {
  if (record.url !== undefined) input.url = normalizeUrl(record.url);
  if (record.bundle !== undefined) {
    input.bundle = normalizeBundle(record.bundle);
  }
  if (input.url !== undefined && input.bundle !== undefined) {
    throw new Error("url and bundle are mutually exclusive");
  }
  if (input.url !== undefined) input.transport = "http";
  if (input.bundle !== undefined) input.transport = "hosted";
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(
      `description must be a string of at most ${MAX_DESCRIPTION_LENGTH} characters`,
    );
  }

  return value;
}

function normalizeHeaders(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("headers must be an object of header name to value");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_HEADERS) {
    throw new Error(`headers must contain at most ${MAX_HEADERS} entries`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      throw new Error(`headers names must be RFC 9110 tokens: ${name}`);
    }
    if (
      typeof headerValue !== "string" ||
      headerValue.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new Error(
        `headers values must be single-line strings of at most ${MAX_HEADER_VALUE_LENGTH} characters`,
      );
    }
    if (
      SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) &&
      !ACCOUNT_ENV_PLACEHOLDER_PATTERN.test(headerValue)
    ) {
      throw new Error(
        `headers values for ${name} must reference an account env var like \${NAME}, not an inline secret`,
      );
    }
    headers[name] = headerValue;
  }

  return headers;
}

function normalizeName(value: unknown): string {
  if (typeof value !== "string" || !MCP_NAME_PATTERN.test(value)) {
    throw new Error(
      "name must be 1-32 lowercase letters, digits or hyphens, starting with a letter",
    );
  }

  return value;
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new Error(
      `url must be a string of at most ${MAX_URL_LENGTH} characters`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`url must be a valid absolute URL: ${value}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("url must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "url must not embed credentials; put them in headers as ${NAME} refs",
    );
  }

  return value;
}
