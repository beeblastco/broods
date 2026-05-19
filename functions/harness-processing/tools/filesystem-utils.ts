/**
 * Filesystem helpers for the harness workspace tool.
 * Keep command parsing, path safety, and storage primitives here.
 */

import type { JSONObject, JSONValue } from "@ai-sdk/provider";
import {
  deleteS3Object,
  deleteS3Prefix,
  listS3Prefix,
  readS3Bytes,
  readS3Text,
  s3ObjectExists,
  writeS3Object,
} from "../../_shared/s3.ts";
import { requireEnv } from "../../_shared/env.ts";
import { logError, logInfo } from "../../_shared/log.ts";
import type {
  WorkspaceSandboxRunResult,
  WorkspaceSandboxRuntime,
} from "../sandbox/types.ts";

export interface FilesystemInput {
  shell: string;
}

interface StoredPathState {
  exists: boolean;
  isDirectory: boolean;
}

interface StoredObject {
  key: string;
  relativeKey: string;
}

export function getFilesystemBucketName(): string {
  return requireEnv("FILESYSTEM_BUCKET_NAME");
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
    executable: executable,
    runtime: executable === "node" ? "node" : "python",
    path: path,
    args: tokens.slice(2),
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

export function parseLsPath(command: string): string {
  const tokens = command.split(/\s+/).slice(1);
  const path = tokens.find((token) => !token.startsWith("-"));
  return path ? stripQuotes(path) : "/";
}

export function parseHeredocCommand(command: string): {
  path: string;
  body: string;
  append: boolean;
} | null {
  const leading = command.match(/^cat\s+<<['"]?([A-Za-z0-9_]+)['"]?\s*(>>|>)\s*(\S+)\n([\s\S]*?)\n\1\s*$/);
  if (leading) {
    return {
      path: stripQuotes(leading[3]!),
      body: leading[4]!,
      append: leading[2] === ">>",
    };
  }

  const trailing = command.match(/^cat\s*(>>|>)\s*(\S+)\s*<<['"]?([A-Za-z0-9_]+)['"]?\n([\s\S]*?)\n\3\s*$/);
  if (trailing) {
    return {
      path: stripQuotes(trailing[2]!),
      body: trailing[4]!,
      append: trailing[1] === ">>",
    };
  }

  return null;
}

export function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

export function getVisibleRoot(namespace: string): string {
  return `/${namespace}`;
}

export function toScopedPath(path: string, namespace: string): string {
  const normalized = normalizePath(path);
  const visibleRoot = getVisibleRoot(namespace);

  if (normalized === visibleRoot) {
    return "/";
  }

  if (normalized.startsWith(`${visibleRoot}/`)) {
    return normalized.slice(visibleRoot.length) || "/";
  }

  return normalized;
}

export function toVisiblePath(path: string, namespace: string): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? getVisibleRoot(namespace) : `${getVisibleRoot(namespace)}${normalized}`;
}

export function toStorageKey(path: string, namespace: string): string {
  const normalizedPath = toScopedPath(path, namespace);
  assertSafeScopedPath(normalizedPath);

  const relativePath = normalizedPath.slice(1);
  const s3Key = relativePath ? `${namespace}/${relativePath}` : namespace;

  if (s3Key !== namespace && !s3Key.startsWith(`${namespace}/`)) {
    throw new Error("Invalid path: resolved outside filesystem root");
  }

  return s3Key;
}

function normalizePath(path: string): string {
  const trimmed = stripQuotes(path).trim();
  if (!trimmed || trimmed === ".") {
    return "/";
  }

  const absolute = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = absolute.split("/").filter(Boolean);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function assertSafeScopedPath(path: string): void {
  const normalized = path.toLowerCase();
  if (normalized.includes("%2e%2e")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }

  if (path.split("/").some((segment) => segment === "..")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }
}

export async function readFilesystemRaw(path: string, namespace: string): Promise<string> {
  const normalizedPath = toScopedPath(path, namespace);
  const state = await checkPathExists(namespace, normalizedPath);
  if (!state.exists) {
    return `cat: ${toVisiblePath(normalizedPath, namespace)}: No such file or directory`;
  }

  if (state.isDirectory) {
    return `cat: ${toVisiblePath(normalizedPath, namespace)}: Is a directory`;
  }

  return readS3Text(getFilesystemBucketName(), toStorageKey(normalizedPath, namespace));
}

export async function readFilesystemRange(
  path: string,
  start: number,
  end: number,
  namespace: string,
): Promise<string> {
  const content = await readFilesystemRaw(path, namespace);
  if (content.startsWith("cat: ")) {
    return content;
  }

  return content
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(start - 1, end))
    .join("\n");
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

export function boundedInteger(value: unknown, defaultValue: number, max: number): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`workspace sandbox numeric option must be an integer from 1 to ${max}`);
  }

  return value;
}

export async function writeFilesystemFile(params: {
  name: string;
  fileText: string;
  namespace: string;
}): Promise<string> {
  const { name, fileText, namespace } = params;
  const path = toScopedPath(name, namespace);
  if (path === "/") {
    return `Error: ${toVisiblePath(path, namespace)} is a directory`;
  }

  const { isDirectory } = await checkPathExists(namespace, path);
  if (isDirectory) {
    return `Error: ${toVisiblePath(path, namespace)} is a directory`;
  }

  const bucket = getFilesystemBucketName();
  const key = toStorageKey(path, namespace);
  logInfo("filesystem writeS3Object start", { bucket, key, contentType: "text/plain", bodyLength: fileText.length });

  try {
    await writeS3Object(bucket, key, fileText, {
      contentType: "text/plain",
    });
    logInfo("filesystem writeS3Object success", { bucket, key });
  } catch (err) {
    logError("filesystem writeS3Object failed", {
      bucket,
      key,
      error: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : typeof err,
      errorStack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }

  return `Wrote ${toVisiblePath(path, namespace)}`;
}

export async function appendToFilesystemFile(path: string, fileText: string, namespace: string): Promise<string> {
  const normalizedPath = toScopedPath(path, namespace);
  const { exists, isDirectory } = await checkPathExists(namespace, normalizedPath);
  if (isDirectory) {
    throw new Error(`${toVisiblePath(normalizedPath, namespace)} is a directory`);
  }

  if (!exists) {
    return fileText;
  }

  const existing = await readFilesystemRaw(normalizedPath, namespace);
  return existing.length > 0 ? `${existing}\n${fileText}` : fileText;
}

export async function createFilesystemDirectory(path: string, namespace: string): Promise<string> {
  const normalizedPath = toScopedPath(path, namespace);
  if (normalizedPath === "/") {
    return `Directory already exists: ${toVisiblePath(normalizedPath, namespace)}`;
  }

  const { exists, isDirectory } = await checkPathExists(namespace, normalizedPath);
  if (exists && isDirectory) {
    return `Directory already exists: ${toVisiblePath(normalizedPath, namespace)}`;
  }

  if (exists) {
    return `Error: ${toVisiblePath(normalizedPath, namespace)} is a file`;
  }

  await writeS3Object(getFilesystemBucketName(), `${toStorageKey(normalizedPath, namespace)}/.keep`, "", {
    contentType: "text/plain",
  });

  return `Created directory ${toVisiblePath(normalizedPath, namespace)}`;
}

export async function touchFilesystemFile(path: string, namespace: string): Promise<string> {
  const normalizedPath = toScopedPath(path, namespace);
  if (normalizedPath === "/") {
    return `Error: ${toVisiblePath(normalizedPath, namespace)} is a directory`;
  }

  const { exists, isDirectory } = await checkPathExists(namespace, normalizedPath);
  if (isDirectory) {
    return `Error: ${toVisiblePath(normalizedPath, namespace)} is a directory`;
  }

  if (exists) {
    return `Touched ${toVisiblePath(normalizedPath, namespace)}`;
  }

  return writeFilesystemFile({
    name: normalizedPath,
    fileText: "",
    namespace,
  });
}

export async function listFilesystemEntries(path: string, namespace: string): Promise<string> {
  const normalizedPath = toScopedPath(path, namespace);
  const state = await checkPathExists(namespace, normalizedPath);

  if (normalizedPath !== "/" && !state.exists) {
    return `ls: ${toVisiblePath(normalizedPath, namespace)}: No such file or directory`;
  }

  if (state.exists && !state.isDirectory) {
    return normalizedPath.split("/").pop() ?? normalizedPath;
  }

  const entries = await listDirectoryEntries(namespace, normalizedPath);
  return entries.sort((a, b) => a.localeCompare(b)).join("\n");
}

export async function checkPathExists(namespace: string, path: string): Promise<StoredPathState> {
  const normalizedPath = toScopedPath(path, namespace);
  if (normalizedPath === "/") {
    return { exists: true, isDirectory: true };
  }

  const key = toStorageKey(normalizedPath, namespace);

  if (await s3ObjectExists(getFilesystemBucketName(), key)) {
    return { exists: true, isDirectory: false };
  }
  const listResponse = await listS3Prefix(getFilesystemBucketName(), `${key}/`);
  return {
    exists: listResponse.length > 0,
    isDirectory: listResponse.length > 0,
  };
}

async function listDirectoryEntries(namespace: string, normalizedPath: string): Promise<string[]> {
  const prefix = normalizedPath === "/"
    ? `${namespace}/`
    : `${toStorageKey(normalizedPath, namespace)}/`;

  const objects = await listS3Prefix(getFilesystemBucketName(), prefix);
  const directories = new Set<string>();
  const files = new Set<string>();
  for (const object of objects) {
    const relative = object.key.slice(prefix.length);
    if (!relative || relative.startsWith(".")) {
      continue;
    }
    const [head, ...rest] = relative.split("/");
    if (!head || head.startsWith(".")) {
      continue;
    }
    if (rest.length > 0) {
      directories.add(`${head}/`);
    } else {
      files.add(head);
    }
  }

  return [
    ...directories,
    ...files,
  ];
}

export async function deleteFilesystemPath(params: {
  name: string;
  namespace: string;
}): Promise<string> {
  const { name, namespace } = params;
  const path = toScopedPath(name, namespace);
  if (path === "/") {
    return `Error: refusing to delete ${toVisiblePath(path, namespace)}`;
  }

  const state = await checkPathExists(namespace, path);
  if (!state.exists) {
    return `Error: The path ${toVisiblePath(path, namespace)} does not exist`;
  }

  if (state.isDirectory) {
    const prefix = `${toStorageKey(path, namespace)}/`;
    await deleteS3Prefix(getFilesystemBucketName(), prefix);
  } else {
    await deleteS3Object(getFilesystemBucketName(), toStorageKey(path, namespace));
  }

  return `Successfully deleted ${toVisiblePath(path, namespace)}`;
}

export async function renameFilesystemPath(params: {
  oldName: string;
  newName: string;
  namespace: string;
}): Promise<string> {
  const { namespace } = params;
  const oldPath = toScopedPath(params.oldName, namespace);
  const newPath = toScopedPath(params.newName, namespace);
  if (oldPath === "/" || newPath === "/") {
    return `Error: cannot rename ${toVisiblePath("/", namespace)}`;
  }

  const sourceState = await checkPathExists(namespace, oldPath);
  if (!sourceState.exists) {
    return `Error: The path ${toVisiblePath(oldPath, namespace)} does not exist`;
  }

  const destinationState = await checkPathExists(namespace, newPath);
  if (destinationState.exists) {
    return `Error: The destination ${toVisiblePath(newPath, namespace)} already exists`;
  }

  if (sourceState.isDirectory) {
    const sourceObjects = await collectDirectoryObjects(namespace, oldPath);

    for (const object of sourceObjects) {
      await writeS3Object(
        getFilesystemBucketName(),
        `${toStorageKey(newPath, namespace)}/${object.relativeKey}`,
        await readS3Bytes(getFilesystemBucketName(), object.key),
      );
    }

    for (const object of sourceObjects) {
      await deleteS3Object(getFilesystemBucketName(), object.key);
    }
  } else {
    const oldKey = toStorageKey(oldPath, namespace);
    const newKey = toStorageKey(newPath, namespace);

    await writeS3Object(getFilesystemBucketName(), newKey, await readS3Bytes(getFilesystemBucketName(), oldKey));
    await deleteS3Object(getFilesystemBucketName(), oldKey);
  }

  return `Successfully renamed ${toVisiblePath(oldPath, namespace)} to ${toVisiblePath(newPath, namespace)}`;
}

async function collectDirectoryObjects(namespace: string, path: string): Promise<StoredObject[]> {
  const normalizedPath = toScopedPath(path, namespace);
  const prefix = `${toStorageKey(normalizedPath, namespace)}/`;
  const response = await listS3Prefix(getFilesystemBucketName(), prefix);

  return response
    .map((item) => item.key)
    .map((key) => ({
      key,
      relativeKey: key.slice(prefix.length),
    }));
}
