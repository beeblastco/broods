/**
 * S3-backed persistent filesystem tool for the harness agent.
 * Keep filesystem operations, namespace fallback, and S3 path safety here.
 */

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { jsonSchema, tool, type ToolSet } from "ai";
import { requireEnv } from "../../_shared/env.ts";
import {
  filesystemNamespaceCandidates,
  normalizeFilesystemNamespace,
} from "../utils.ts";
import type { ToolContext } from "./index.ts";

const s3 = new S3Client({ region: process.env.AWS_REGION });

const FILESYSTEM_BUCKET_NAME = requireEnv("FILESYSTEM_BUCKET_NAME");

interface FilesystemInput {
  shell: string;
}

interface FilesystemScope {
  primaryNamespace: string;
  legacyNamespace: string | null;
}

interface StoredPathState {
  exists: boolean;
  isDirectory: boolean;
  namespace: string | null;
}

interface NamespacedObject {
  namespace: string;
  key: string;
  relativeKey: string;
}

type CommandResult = { result: string; isError: boolean };

const filesystemInputSchema = {
  type: "object",
  properties: {
    shell: {
      type: "string",
      description: `Terminal command to run against the virtual filesystem rooted at /.

Prefer shell mode. Supported commands:
- pwd
- ls [path]
- cat <path>
- sed -n 'start,endp' <path>
- mkdir -p <dir>
- touch <file>
- rm -r <path>
- mv <old> <new>
- cat <<'EOF' > <path> ... EOF
- cat <<'EOF' >> <path> ... EOF`,
    },
  },
  required: ["shell"],
  additionalProperties: false,
} as const;

const error = (result: string): CommandResult => ({ result, isError: true });
const success = (result: string): CommandResult => ({ result, isError: false });

export default function filesystemTool(context: ToolContext): ToolSet {
  const scope = createFilesystemScope(context.conversationKey);

  return {
    filesystem: tool({
      description: "Terminal-style filesystem rooted at /. Use shell commands to read and write persistent files.",
      inputSchema: jsonSchema(filesystemInputSchema),
      async execute(input) {
        const { result, isError } = await executeShellCommand((input as FilesystemInput).shell, scope);
        return { type: isError ? "error-text" : "text", value: result };
      },
    }),
  };
}

function createFilesystemScope(conversationKey: string): FilesystemScope {
  const primaryNamespace = normalizeFilesystemNamespace(conversationKey);
  const candidates = filesystemNamespaceCandidates(conversationKey);

  return {
    primaryNamespace,
    legacyNamespace: candidates.find((candidate) => candidate !== primaryNamespace) ?? null,
  };
}

async function executeShellCommand(shell: string, scope: FilesystemScope): Promise<CommandResult> {
  const command = shell.trim();
  if (!command) {
    return error("Error: shell command is required");
  }

  if (command === "pwd") {
    return success(getVisibleRoot(scope));
  }

  const heredoc = parseHeredocCommand(command);
  if (heredoc) {
    try {
      return success(await writeFilesystemFile({
        name: heredoc.path,
        fileText: heredoc.append
          ? await appendToFilesystemFile(heredoc.path, heredoc.body, scope)
          : heredoc.body,
        scope,
      }));
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (command.startsWith("ls")) {
    const path = parseLsPath(command);
    return success(await listFilesystemEntries(path, scope));
  }

  const sedMatch = command.match(/^sed\s+-n\s+['"](\d+),(\d+)p['"]\s+(.+)$/s);
  if (sedMatch) {
    return success(await readFilesystemRange(
      stripQuotes(sedMatch[3]!),
      Number(sedMatch[1]),
      Number(sedMatch[2]),
      scope,
    ));
  }

  const catMatch = command.match(/^cat\s+(.+)$/s);
  if (catMatch) {
    return success(await readFilesystemRaw(stripQuotes(catMatch[1]!), scope));
  }

  const mkdirMatch = command.match(/^mkdir\s+-p\s+(.+)$/s);
  if (mkdirMatch) {
    return success(await createFilesystemDirectory(stripQuotes(mkdirMatch[1]!), scope));
  }

  const touchMatch = command.match(/^touch\s+(.+)$/s);
  if (touchMatch) {
    return success(await touchFilesystemFile(stripQuotes(touchMatch[1]!), scope));
  }

  const rmMatch = command.match(/^rm(?:\s+-[rf]+\s+|\s+-[fr]+\s+|\s+)(.+)$/s);
  if (rmMatch) {
    return success(await deleteFilesystemPath({
      name: stripQuotes(rmMatch[1]!),
      scope,
    }));
  }

  const mvMatch = command.match(/^mv\s+(\S+)\s+(\S+)$/);
  if (mvMatch) {
    return success(await renameFilesystemPath({
      oldName: stripQuotes(mvMatch[1]!),
      newName: stripQuotes(mvMatch[2]!),
      scope,
    }));
  }

  return error(`Unsupported shell command.
Supported commands:
- pwd
- ls [path]
- cat <path>
- sed -n 'start,endp' <path>
- mkdir -p <dir>
- touch <file>
- rm -r <path>
- mv <old> <new>
- cat <<'EOF' > <path> ... EOF
- cat <<'EOF' >> <path> ... EOF`);
}

function parseLsPath(command: string): string {
  const tokens = command.split(/\s+/).slice(1);
  const path = tokens.find((token) => !token.startsWith("-"));
  return path ? stripQuotes(path) : "/";
}

function parseHeredocCommand(command: string): {
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

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function getVisibleRoot(scope: FilesystemScope): string {
  return `/${scope.primaryNamespace}`;
}

function namespaceCandidates(scope: FilesystemScope): string[] {
  return scope.legacyNamespace == null
    ? [scope.primaryNamespace]
    : [scope.primaryNamespace, scope.legacyNamespace];
}

function toScopedPath(path: string, scope: FilesystemScope): string {
  const normalized = normalizePath(path);
  const currentVisibleRoot = getVisibleRoot(scope);

  if (normalized === currentVisibleRoot) {
    return "/";
  }

  if (normalized.startsWith(`${currentVisibleRoot}/`)) {
    return normalized.slice(currentVisibleRoot.length) || "/";
  }

  if (scope.legacyNamespace) {
    const legacyVisibleRoot = `/${scope.legacyNamespace}`;
    if (normalized === legacyVisibleRoot) {
      return "/";
    }

    if (normalized.startsWith(`${legacyVisibleRoot}/`)) {
      return normalized.slice(legacyVisibleRoot.length) || "/";
    }
  }

  return normalized;
}

function toVisiblePath(path: string, scope: FilesystemScope): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? getVisibleRoot(scope) : `${getVisibleRoot(scope)}${normalized}`;
}

function toStorageKey(path: string, namespace: string): string {
  const normalizedPath = normalizePath(path);
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

async function readFilesystemRaw(path: string, scope: FilesystemScope): Promise<string> {
  const normalizedPath = toScopedPath(path, scope);
  const state = await checkPathExists(scope, normalizedPath);
  if (!state.exists) {
    return `cat: ${toVisiblePath(normalizedPath, scope)}: No such file or directory`;
  }

  if (state.isDirectory || state.namespace == null) {
    return `cat: ${toVisiblePath(normalizedPath, scope)}: Is a directory`;
  }

  const response = await s3.send(new GetObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: toStorageKey(normalizedPath, state.namespace),
  }));

  return await response.Body?.transformToString() ?? "";
}

async function readFilesystemRange(
  path: string,
  start: number,
  end: number,
  scope: FilesystemScope,
): Promise<string> {
  const content = await readFilesystemRaw(path, scope);
  if (content.startsWith("cat: ")) {
    return content;
  }

  return content
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(start - 1, end))
    .join("\n");
}

async function writeFilesystemFile(params: {
  name: string;
  fileText: string;
  scope: FilesystemScope;
}): Promise<string> {
  const { name, fileText, scope } = params;
  const path = toScopedPath(name, scope);
  if (path === "/") {
    return `Error: ${toVisiblePath(path, scope)} is a directory`;
  }

  const { isDirectory } = await checkPathExists(scope, path);
  if (isDirectory) {
    return `Error: ${toVisiblePath(path, scope)} is a directory`;
  }

  await s3.send(new PutObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: toStorageKey(path, scope.primaryNamespace),
    Body: fileText,
    ContentType: "text/plain",
  }));

  return `Wrote ${toVisiblePath(path, scope)}`;
}

async function appendToFilesystemFile(path: string, fileText: string, scope: FilesystemScope): Promise<string> {
  const normalizedPath = toScopedPath(path, scope);
  const state = await checkPathExists(scope, normalizedPath);
  if (state.isDirectory) {
    throw new Error(`${toVisiblePath(normalizedPath, scope)} is a directory`);
  }

  if (!state.exists) {
    return fileText;
  }

  const existing = await readFilesystemRaw(normalizedPath, scope);
  return existing.length > 0 ? `${existing}\n${fileText}` : fileText;
}

async function createFilesystemDirectory(path: string, scope: FilesystemScope): Promise<string> {
  const normalizedPath = toScopedPath(path, scope);
  if (normalizedPath === "/") {
    return `Directory already exists: ${toVisiblePath(normalizedPath, scope)}`;
  }

  const { exists, isDirectory } = await checkPathExists(scope, normalizedPath);
  if (exists && isDirectory) {
    return `Directory already exists: ${toVisiblePath(normalizedPath, scope)}`;
  }

  if (exists) {
    return `Error: ${toVisiblePath(normalizedPath, scope)} is a file`;
  }

  await s3.send(new PutObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: `${toStorageKey(normalizedPath, scope.primaryNamespace)}/.keep`,
    Body: "",
    ContentType: "text/plain",
  }));

  return `Created directory ${toVisiblePath(normalizedPath, scope)}`;
}

async function touchFilesystemFile(path: string, scope: FilesystemScope): Promise<string> {
  const normalizedPath = toScopedPath(path, scope);
  if (normalizedPath === "/") {
    return `Error: ${toVisiblePath(normalizedPath, scope)} is a directory`;
  }

  const { exists, isDirectory } = await checkPathExists(scope, normalizedPath);
  if (isDirectory) {
    return `Error: ${toVisiblePath(normalizedPath, scope)} is a directory`;
  }

  if (exists) {
    return `Touched ${toVisiblePath(normalizedPath, scope)}`;
  }

  return writeFilesystemFile({
    name: normalizedPath,
    fileText: "",
    scope,
  });
}

async function listFilesystemEntries(path: string, scope: FilesystemScope): Promise<string> {
  const normalizedPath = toScopedPath(path, scope);
  const state = await checkPathExists(scope, normalizedPath);

  if (normalizedPath !== "/" && !state.exists) {
    return `ls: ${toVisiblePath(normalizedPath, scope)}: No such file or directory`;
  }

  if (state.exists && !state.isDirectory) {
    return normalizedPath.split("/").pop() ?? normalizedPath;
  }

  const entries = new Map<string, string>();

  for (const namespace of namespaceCandidates(scope)) {
    for (const entry of await listDirectoryEntriesInNamespace(namespace, normalizedPath)) {
      if (!entries.has(entry.name)) {
        entries.set(entry.name, entry.display);
      }
    }
  }

  return Array.from(entries.values()).sort((a, b) => a.localeCompare(b)).join("\n");
}

async function checkPathExists(
  scope: FilesystemScope,
  path: string,
): Promise<StoredPathState> {
  const normalizedPath = toScopedPath(path, scope);
  if (normalizedPath === "/") {
    return { exists: true, isDirectory: true, namespace: scope.primaryNamespace };
  }

  for (const namespace of namespaceCandidates(scope)) {
    const state = await checkPathExistsInNamespace(namespace, normalizedPath);
    if (state.exists) {
      return { ...state, namespace };
    }
  }

  return { exists: false, isDirectory: false, namespace: null };
}

async function checkPathExistsInNamespace(
  namespace: string,
  path: string,
): Promise<{ exists: boolean; isDirectory: boolean }> {
  const s3Key = toStorageKey(path, namespace);

  try {
    await s3.send(new HeadObjectCommand({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Key: s3Key,
    }));
    return { exists: true, isDirectory: false };
  } catch {
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Prefix: `${s3Key}/`,
      MaxKeys: 1,
    }));

    if ((listResponse.Contents ?? []).length > 0) {
      return { exists: true, isDirectory: true };
    }

    return { exists: false, isDirectory: false };
  }
}

async function listDirectoryEntriesInNamespace(
  namespace: string,
  normalizedPath: string,
): Promise<Array<{ name: string; display: string }>> {
  const prefix = normalizedPath === "/"
    ? `${namespace}/`
    : `${toStorageKey(normalizedPath, namespace)}/`;

  const response = await s3.send(new ListObjectsV2Command({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Prefix: prefix,
    Delimiter: "/",
  }));

  return [
    ...(response.CommonPrefixes ?? [])
      .map((item) => item.Prefix?.slice(prefix.length)?.replace(/\/$/, ""))
      .filter((item): item is string => typeof item === "string" && !item.startsWith("."))
      .map((item) => ({ name: item, display: `${item}/` })),
    ...(response.Contents ?? [])
      .map((item) => item.Key?.slice(prefix.length))
      .filter((item): item is string => typeof item === "string" && item.length > 0 && !item.startsWith("."))
      .map((item) => ({ name: item, display: item })),
  ];
}

async function deleteFilesystemPath(params: {
  name: string;
  scope: FilesystemScope;
}): Promise<string> {
  const { name, scope } = params;
  const path = toScopedPath(name, scope);
  if (path === "/") {
    return `Error: refusing to delete ${toVisiblePath(path, scope)}`;
  }

  const state = await checkPathExists(scope, path);
  if (!state.exists) {
    return `Error: The path ${toVisiblePath(path, scope)} does not exist`;
  }

  if (state.isDirectory) {
    for (const namespace of namespaceCandidates(scope)) {
      const prefix = `${toStorageKey(path, namespace)}/`;
      const listResponse = await s3.send(new ListObjectsV2Command({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Prefix: prefix,
      }));

      for (const item of listResponse.Contents ?? []) {
        if (!item.Key) continue;
        await s3.send(new DeleteObjectCommand({
          Bucket: FILESYSTEM_BUCKET_NAME,
          Key: item.Key,
        }));
      }
    }
  } else {
    for (const namespace of namespaceCandidates(scope)) {
      await s3.send(new DeleteObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Key: toStorageKey(path, namespace),
      }));
    }
  }

  return `Successfully deleted ${toVisiblePath(path, scope)}`;
}

async function renameFilesystemPath(params: {
  oldName: string;
  newName: string;
  scope: FilesystemScope;
}): Promise<string> {
  const { scope } = params;
  const oldPath = toScopedPath(params.oldName, scope);
  const newPath = toScopedPath(params.newName, scope);
  if (oldPath === "/" || newPath === "/") {
    return `Error: cannot rename ${toVisiblePath("/", scope)}`;
  }

  const sourceState = await checkPathExists(scope, oldPath);
  if (!sourceState.exists) {
    return `Error: The path ${toVisiblePath(oldPath, scope)} does not exist`;
  }

  const destinationState = await checkPathExists(scope, newPath);
  if (destinationState.exists) {
    return `Error: The destination ${toVisiblePath(newPath, scope)} already exists`;
  }

  if (sourceState.isDirectory) {
    const sourceObjects = await collectDirectoryObjects(scope, oldPath);
    const copied = new Set<string>();

    for (const object of sourceObjects) {
      if (copied.has(object.relativeKey)) {
        continue;
      }

      copied.add(object.relativeKey);

      await s3.send(new CopyObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        CopySource: toCopySource(object.key),
        Key: `${toStorageKey(newPath, scope.primaryNamespace)}/${object.relativeKey}`,
      }));
    }

    for (const object of sourceObjects) {
      await s3.send(new DeleteObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Key: object.key,
      }));
    }
  } else {
    const sourceObjects = await collectFileObjects(scope, oldPath);
    const source = sourceObjects[0];
    if (!source) {
      return `Error: The path ${toVisiblePath(oldPath, scope)} does not exist`;
    }

    await s3.send(new CopyObjectCommand({
      Bucket: FILESYSTEM_BUCKET_NAME,
      CopySource: toCopySource(source.key),
      Key: toStorageKey(newPath, scope.primaryNamespace),
    }));

    for (const object of sourceObjects) {
      await s3.send(new DeleteObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Key: object.key,
      }));
    }
  }

  return `Successfully renamed ${toVisiblePath(oldPath, scope)} to ${toVisiblePath(newPath, scope)}`;
}

async function collectDirectoryObjects(scope: FilesystemScope, path: string): Promise<NamespacedObject[]> {
  const normalizedPath = toScopedPath(path, scope);
  const objects: NamespacedObject[] = [];

  for (const namespace of namespaceCandidates(scope)) {
    const prefix = `${toStorageKey(normalizedPath, namespace)}/`;
    const response = await s3.send(new ListObjectsV2Command({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Prefix: prefix,
    }));

    for (const item of response.Contents ?? []) {
      if (!item.Key) {
        continue;
      }

      objects.push({
        namespace,
        key: item.Key,
        relativeKey: item.Key.slice(prefix.length),
      });
    }
  }

  return objects;
}

async function collectFileObjects(scope: FilesystemScope, path: string): Promise<NamespacedObject[]> {
  const normalizedPath = toScopedPath(path, scope);
  const objects: NamespacedObject[] = [];

  for (const namespace of namespaceCandidates(scope)) {
    const key = toStorageKey(normalizedPath, namespace);

    try {
      await s3.send(new HeadObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Key: key,
      }));

      objects.push({
        namespace,
        key,
        relativeKey: "",
      });
    } catch {
      continue;
    }
  }

  return objects;
}

function toCopySource(key: string): string {
  return `${FILESYSTEM_BUCKET_NAME}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}
