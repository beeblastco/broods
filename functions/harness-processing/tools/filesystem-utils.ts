/**
 * Filesystem tool helpers for shell delegation.
 * Keep command parsing, path normalization, and result formatting here.
 */

import type { JSONObject, JSONValue } from "@ai-sdk/provider";
import type {
  WorkspaceSandboxRunResult,
  WorkspaceSandboxRuntime,
} from "../sandbox/types.ts";

export interface FilesystemInput {
  shell: string;
}

export function parseExecutionCommand(command: string): {
  runtime: WorkspaceSandboxRuntime;
  executable: "node" | "python" | "python3";
  path: string;
  args: string[];
} | null {
  const tokens = parseShellTokens(command);
  const executable = tokens[0];
  if (executable !== "node" && executable !== "python" && executable !== "python3") {
    return null;
  }

  const path = tokens[1];
  if (!path || path.startsWith("-")) {
    throw new Error("Execution command must reference one workspace file and cannot use inline flags");
  }

  return {
    executable,
    runtime: executable === "node" ? "node" : "python",
    path,
    args: tokens.slice(2),
  };
}

export function toScopedPath(path: string, namespace: string): string {
  const normalized = normalizePath(path);
  const visibleRoot = `/${namespace}`;

  if (normalized === visibleRoot) {
    return "/";
  }

  if (normalized.startsWith(`${visibleRoot}/`)) {
    return normalized.slice(visibleRoot.length) || "/";
  }

  return normalized;
}

export function assertExecutableExtension(path: string, runtime: WorkspaceSandboxRuntime): void {
  if (runtime === "node" && !path.endsWith(".js") && !path.endsWith(".ts")) {
    throw new Error("node execution only supports .js and .ts files");
  }

  if (runtime === "python" && !path.endsWith(".py")) {
    throw new Error("python execution only supports .py files");
  }
}

export function assertSafeExecutionArgs(args: string[]): void {
  if (args.some((arg) => arg.includes("\0"))) {
    throw new Error("Execution command arguments cannot include null bytes");
  }
}

export function boundedInteger(value: unknown, defaultValue: number, max: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`workspace sandbox numeric option must be an integer from 1 to ${max}`);
  }

  return value;
}

export function formatSandboxResult(result: WorkspaceSandboxRunResult): JSONObject {
  return {
    output: {
      stdout: result.stdout,
      stderr: result.stderr,
      artifacts: (result.artifacts ?? []).map((artifact) => ({
        kind: artifact.kind,
        path: artifact.path,
        mediaType: artifact.mediaType,
        title: artifact.title,
        dataBase64: artifact.dataBase64,
        metadata: toJsonObject(artifact.metadata),
      })),
    },
    status: {
      ok: result.ok,
      runtime: result.runtime,
      provider: result.provider,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut === true,
      truncated: result.truncated === true,
    },
  };
}

function parseShellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;

  for (const char of command) {
    if ((char === "'" || char === "\"") && quote === null) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (quote) {
    throw new Error("Execution command has an unterminated quote");
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/^['"]|['"]$/g, "").trim();
  if (!trimmed || trimmed === ".") {
    return "/";
  }

  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = absolute.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function toJsonObject(value: Record<string, unknown> | undefined): JSONObject | undefined {
  if (!value) {
    return undefined;
  }

  const object: JSONObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isJsonValue(entry)) {
      object[key] = entry;
    }
  }
  return object;
}

function isJsonValue(value: unknown): value is JSONValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (value && typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}
