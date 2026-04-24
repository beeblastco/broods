/**
 * S3-backed persistent filesystem tool for the harness agent.
 * Keep filesystem operations and S3 path safety here.
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
import { normalizeFilesystemNamespace } from "../filesystem-namespace.ts";
import type { ToolContext } from "./index.ts";

const s3 = new S3Client({ region: process.env.AWS_REGION });
const FILESYSTEM_BUCKET_NAME = requireEnv("FILESYSTEM_BUCKET_NAME");

interface FilesystemInput {
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
  const namespace = normalizeFilesystemNamespace(context.conversationKey);

  return {
    filesystem: tool({
      description: "Terminal-style filesystem rooted at /. Use shell commands to read and write persistent files.",
      inputSchema: jsonSchema(filesystemInputSchema),
      async execute(input) {
        const { result, isError } = await executeShellCommand((input as FilesystemInput).shell, namespace);
        return { type: isError ? "error-text" : "text", value: result };
      },
    }),
  };
}

async function executeShellCommand(shell: string, namespace: string): Promise<CommandResult> {
  const command = shell.trim();
  if (!command) {
    return error("Error: shell command is required");
  }

  if (command === "pwd") {
    return success(getVisibleRoot(namespace));
  }

  const heredoc = parseHeredocCommand(command);
  if (heredoc) {
    try {
      return success(await writeFilesystemFile({
        name: heredoc.path,
        fileText: heredoc.append
          ? await appendToFilesystemFile(heredoc.path, heredoc.body, namespace)
          : heredoc.body,
        namespace,
      }));
    } catch (cause) {
      return error(cause instanceof Error ? cause.message : String(cause));
    }
  }

  if (command.startsWith("ls")) {
    return success(await listFilesystemEntries(parseLsPath(command), namespace));
  }

  const sedMatch = command.match(/^sed\s+-n\s+['"](\d+),(\d+)p['"]\s+(.+)$/s);
  if (sedMatch) {
    return success(await readFilesystemRange(stripQuotes(sedMatch[3]!), Number(sedMatch[1]), Number(sedMatch[2]), namespace));
  }

  const catMatch = command.match(/^cat\s+(.+)$/s);
  if (catMatch) {
    return success(await readFilesystemRaw(stripQuotes(catMatch[1]!), namespace));
  }

  const mkdirMatch = command.match(/^mkdir\s+-p\s+(.+)$/s);
  if (mkdirMatch) {
    return success(await createFilesystemDirectory(stripQuotes(mkdirMatch[1]!), namespace));
  }

  const touchMatch = command.match(/^touch\s+(.+)$/s);
  if (touchMatch) {
    return success(await touchFilesystemFile(stripQuotes(touchMatch[1]!), namespace));
  }

  const rmMatch = command.match(/^rm(?:\s+-[rf]+\s+|\s+-[fr]+\s+|\s+)(.+)$/s);
  if (rmMatch) {
    return success(await deleteFilesystemPath({ name: stripQuotes(rmMatch[1]!), namespace: namespace }));
  }

  const mvMatch = command.match(/^mv\s+(\S+)\s+(\S+)$/);
  if (mvMatch) {
    return success(await renameFilesystemPath({ oldName: stripQuotes(mvMatch[1]!), newName: stripQuotes(mvMatch[2]!), namespace: namespace }));
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

function getVisibleRoot(namespace: string): string {
  return `/${namespace}`;
}

function toScopedPath(path: string, namespace: string): string {
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

function toVisiblePath(path: string, namespace: string): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? getVisibleRoot(namespace) : `${getVisibleRoot(namespace)}${normalized}`;
}

function toStorageKey(path: string, namespace: string): string {
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

async function readFilesystemRaw(path: string, namespace: string): Promise<string> {
  const normalizedPath = toScopedPath(path, namespace);
  const state = await checkPathExists(namespace, normalizedPath);
  if (!state.exists) {
    return `cat: ${toVisiblePath(normalizedPath, namespace)}: No such file or directory`;
  }

  if (state.isDirectory) {
    return `cat: ${toVisiblePath(normalizedPath, namespace)}: Is a directory`;
  }

  const response = await s3.send(new GetObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: toStorageKey(normalizedPath, namespace),
  }));

  return await response.Body?.transformToString() ?? "";
}

async function readFilesystemRange(
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

async function writeFilesystemFile(params: {
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

  await s3.send(new PutObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: toStorageKey(path, namespace),
    Body: fileText,
    ContentType: "text/plain",
  }));

  return `Wrote ${toVisiblePath(path, namespace)}`;
}

async function appendToFilesystemFile(path: string, fileText: string, namespace: string): Promise<string> {
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

async function createFilesystemDirectory(path: string, namespace: string): Promise<string> {
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

  await s3.send(new PutObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: `${toStorageKey(normalizedPath, namespace)}/.keep`,
    Body: "",
    ContentType: "text/plain",
  }));

  return `Created directory ${toVisiblePath(normalizedPath, namespace)}`;
}

async function touchFilesystemFile(path: string, namespace: string): Promise<string> {
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

async function listFilesystemEntries(path: string, namespace: string): Promise<string> {
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

async function checkPathExists(namespace: string, path: string): Promise<StoredPathState> {
  const normalizedPath = toScopedPath(path, namespace);
  if (normalizedPath === "/") {
    return { exists: true, isDirectory: true };
  }

  const key = toStorageKey(normalizedPath, namespace);

  try {
    await s3.send(new HeadObjectCommand({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Key: key,
    }));
    return { exists: true, isDirectory: false };
  } catch {
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Prefix: `${key}/`,
      MaxKeys: 1,
    }));

    return {
      exists: (listResponse.Contents ?? []).length > 0,
      isDirectory: (listResponse.Contents ?? []).length > 0,
    };
  }
}

async function listDirectoryEntries(namespace: string, normalizedPath: string): Promise<string[]> {
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
      .map((item) => `${item}/`),
    ...(response.Contents ?? [])
      .map((item) => item.Key?.slice(prefix.length))
      .filter((item): item is string => typeof item === "string" && item.length > 0 && !item.startsWith(".")),
  ];
}

async function deleteFilesystemPath(params: {
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
  } else {
    await s3.send(new DeleteObjectCommand({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Key: toStorageKey(path, namespace),
    }));
  }

  return `Successfully deleted ${toVisiblePath(path, namespace)}`;
}

async function renameFilesystemPath(params: {
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
      await s3.send(new CopyObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        CopySource: toCopySource(object.key),
        Key: `${toStorageKey(newPath, namespace)}/${object.relativeKey}`,
      }));
    }

    for (const object of sourceObjects) {
      await s3.send(new DeleteObjectCommand({
        Bucket: FILESYSTEM_BUCKET_NAME,
        Key: object.key,
      }));
    }
  } else {
    const oldKey = toStorageKey(oldPath, namespace);
    const newKey = toStorageKey(newPath, namespace);

    await s3.send(new CopyObjectCommand({
      Bucket: FILESYSTEM_BUCKET_NAME,
      CopySource: toCopySource(oldKey),
      Key: newKey,
    }));

    await s3.send(new DeleteObjectCommand({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Key: oldKey,
    }));
  }

  return `Successfully renamed ${toVisiblePath(oldPath, namespace)} to ${toVisiblePath(newPath, namespace)}`;
}

async function collectDirectoryObjects(namespace: string, path: string): Promise<StoredObject[]> {
  const normalizedPath = toScopedPath(path, namespace);
  const prefix = `${toStorageKey(normalizedPath, namespace)}/`;
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Prefix: prefix,
  }));

  return (response.Contents ?? [])
    .map((item) => item.Key)
    .filter((key): key is string => typeof key === "string")
    .map((key) => ({
      key,
      relativeKey: key.slice(prefix.length),
    }));
}

function toCopySource(key: string): string {
  return `${FILESYSTEM_BUCKET_NAME}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}
