/**
 * S3-backed persistent memory tool for the harness agent.
 * Keep memory file operations and S3 path safety here.
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
import type { ToolContext } from "./index.ts";

const s3 = new S3Client({ region: process.env.AWS_REGION });

const AWS_S3_BUCKET = requireEnv("AWS_S3_BUCKET");

interface MemoryInput {
  shell: string;
}

type CommandResult = { result: string; isError: boolean };

const memoryInputSchema = {
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

export default function memoryTool(_context: ToolContext): ToolSet {
  const memoryNamespace = normalizeMemoryNamespace(_context.conversationKey);

  return {
    memory: tool({
      description: "Terminal-style filesystem rooted at /. Use shell commands to read and write persistent files.",
      inputSchema: jsonSchema(memoryInputSchema),
      async execute(input) {
        const { result, isError } = await executeShellCommand((input as MemoryInput).shell, memoryNamespace);
        return { type: isError ? "error-text" : "text", value: result };
      },
    }),
  };
}

async function executeShellCommand(shell: string, authId: string): Promise<CommandResult> {
  const command = shell.trim();
  if (!command) {
    return error("Error: shell command is required");
  }

  if (command === "pwd") {
    return success(getVisibleRoot(authId));
  }

  const heredoc = parseHeredocCommand(command);
  if (heredoc) {
    return success(await writeMemoryFile({
      name: heredoc.path,
      fileText: heredoc.append
        ? await appendToMemoryFile(heredoc.path, heredoc.body, authId)
        : heredoc.body,
      userId: authId,
      overwrite: true,
    }));
  }

  if (command.startsWith("ls")) {
    const path = parseLsPath(command);
    return success(await listMemoryEntries(path, authId));
  }

  const sedMatch = command.match(/^sed\s+-n\s+['"](\d+),(\d+)p['"]\s+(.+)$/s);
  if (sedMatch) {
    return success(await readMemoryRange(
      stripQuotes(sedMatch[3]!),
      Number(sedMatch[1]),
      Number(sedMatch[2]),
      authId,
    ));
  }

  const catMatch = command.match(/^cat\s+(.+)$/s);
  if (catMatch) {
    return success(await readMemoryRaw(stripQuotes(catMatch[1]!), authId));
  }

  const mkdirMatch = command.match(/^mkdir\s+-p\s+(.+)$/s);
  if (mkdirMatch) {
    return success(await createMemoryDirectory(stripQuotes(mkdirMatch[1]!), authId));
  }

  const touchMatch = command.match(/^touch\s+(.+)$/s);
  if (touchMatch) {
    return success(await touchMemoryFile(stripQuotes(touchMatch[1]!), authId));
  }

  const rmMatch = command.match(/^rm(?:\s+-[rf]+\s+|\s+-[fr]+\s+|\s+)(.+)$/s);
  if (rmMatch) {
    return success(await deleteMemoryFile({
      name: stripQuotes(rmMatch[1]!),
      userId: authId,
    }));
  }

  const mvMatch = command.match(/^mv\s+(\S+)\s+(\S+)$/);
  if (mvMatch) {
    return success(await renameMemoryFile({
      oldName: stripQuotes(mvMatch[1]!),
      newName: stripQuotes(mvMatch[2]!),
      userId: authId,
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

function normalizeMemoryNamespace(conversationKey: string): string {
  return conversationKey
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

function getVisibleRoot(authId: string): string {
  return `/${authId}`;
}

function toScopedPath(path: string, authId: string): string {
  const normalized = normalizePath(path);
  const visibleRoot = getVisibleRoot(authId);

  if (normalized === visibleRoot) {
    return "/";
  }

  if (normalized.startsWith(`${visibleRoot}/`)) {
    return normalized.slice(visibleRoot.length) || "/";
  }

  return normalized;
}

function toVisiblePath(path: string, authId: string): string {
  const normalized = normalizePath(path);
  return normalized === "/" ? getVisibleRoot(authId) : `${getVisibleRoot(authId)}${normalized}`;
}

function toS3Key(path: string, authId: string): string {
  const normalizedPath = toScopedPath(path, authId);
  if (normalizedPath.includes("../") || normalizedPath.includes("..\\") || normalizedPath.includes("%2e%2e")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }

  const relativePath = normalizedPath.slice(1);
  const s3Key = relativePath ? `${authId}/${relativePath}` : authId;

  if (s3Key !== authId && !s3Key.startsWith(`${authId}/`)) {
    throw new Error("Invalid path: resolved outside memory directory");
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

async function readMemoryRaw(path: string, authId: string): Promise<string> {
  const normalizedPath = toScopedPath(path, authId);
  const { exists, isDirectory } = await checkPathExists(authId, normalizedPath);
  if (!exists) {
    return `cat: ${toVisiblePath(normalizedPath, authId)}: No such file or directory`;
  }

  if (isDirectory) {
    return `cat: ${toVisiblePath(normalizedPath, authId)}: Is a directory`;
  }

  const response = await s3.send(new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: toS3Key(normalizedPath, authId),
  }));

  return await response.Body?.transformToString() ?? "";
}

async function readMemoryRange(path: string, start: number, end: number, authId: string): Promise<string> {
  const content = await readMemoryRaw(path, authId);
  if (content.startsWith("cat: ")) {
    return content;
  }

  return content
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(start - 1, end))
    .join("\n");
}

async function writeMemoryFile(params: {
  name: string;
  fileText: string;
  userId: string;
  overwrite: boolean;
}): Promise<string> {
  const { name, fileText, userId: authId, overwrite } = params;
  const path = toScopedPath(name, authId);
  if (path === "/") {
    return `Error: ${toVisiblePath(path, authId)} is a directory`;
  }

  const { exists, isDirectory } = await checkPathExists(authId, path);

  if (isDirectory) {
    return `Error: ${toVisiblePath(path, authId)} is a directory`;
  }

  if (exists && !overwrite) {
    return `Error: File ${toVisiblePath(path, authId)} already exists`;
  }

  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: toS3Key(path, authId),
    Body: fileText,
    ContentType: "text/plain",
  }));

  return `Wrote ${toVisiblePath(path, authId)}`;
}

async function appendToMemoryFile(path: string, fileText: string, authId: string): Promise<string> {
  const normalizedPath = toScopedPath(path, authId);
  const { exists, isDirectory } = await checkPathExists(authId, normalizedPath);
  if (isDirectory) {
    throw new Error(`${toVisiblePath(normalizedPath, authId)} is a directory`);
  }

  if (!exists) {
    return fileText;
  }

  const existing = await readMemoryRaw(normalizedPath, authId);
  return existing.length > 0 ? `${existing}\n${fileText}` : fileText;
}

async function createMemoryDirectory(path: string, authId: string): Promise<string> {
  const normalizedPath = toScopedPath(path, authId);
  if (normalizedPath === "/") {
    return `Directory already exists: ${toVisiblePath(normalizedPath, authId)}`;
  }

  const { exists, isDirectory } = await checkPathExists(authId, normalizedPath);
  if (exists && isDirectory) {
    return `Directory already exists: ${toVisiblePath(normalizedPath, authId)}`;
  }

  if (exists) {
    return `Error: ${toVisiblePath(normalizedPath, authId)} is a file`;
  }

  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: `${toS3Key(normalizedPath, authId)}/.keep`,
    Body: "",
    ContentType: "text/plain",
  }));

  return `Created directory ${toVisiblePath(normalizedPath, authId)}`;
}

async function touchMemoryFile(path: string, authId: string): Promise<string> {
  const normalizedPath = toScopedPath(path, authId);
  if (normalizedPath === "/") {
    return `Error: ${toVisiblePath(normalizedPath, authId)} is a directory`;
  }

  const { exists, isDirectory } = await checkPathExists(authId, normalizedPath);
  if (isDirectory) {
    return `Error: ${toVisiblePath(normalizedPath, authId)} is a directory`;
  }

  if (exists) {
    return `Touched ${toVisiblePath(normalizedPath, authId)}`;
  }

  return writeMemoryFile({
    name: normalizedPath,
    fileText: "",
    userId: authId,
    overwrite: true,
  });
}

async function listMemoryEntries(path: string, authId: string): Promise<string> {
  const normalizedPath = toScopedPath(path, authId);
  const { exists, isDirectory } = await checkPathExists(authId, normalizedPath);

  if (normalizedPath !== "/" && !exists) {
    return `ls: ${toVisiblePath(normalizedPath, authId)}: No such file or directory`;
  }

  if (exists && !isDirectory) {
    return normalizedPath.split("/").pop() ?? normalizedPath;
  }

  const prefix = normalizedPath === "/"
    ? `${authId}/`
    : `${toS3Key(normalizedPath, authId)}/`;

  const response = await s3.send(new ListObjectsV2Command({
    Bucket: AWS_S3_BUCKET,
    Prefix: prefix,
    Delimiter: "/",
  }));

  const entries = [
    ...(response.CommonPrefixes ?? [])
      .map((item) => item.Prefix?.slice(prefix.length)?.replace(/\/$/, ""))
      .filter((item): item is string => typeof item === "string" && !item.startsWith("."))
      .map((item) => `${item}/`),
    ...(response.Contents ?? [])
      .map((item) => item.Key?.slice(prefix.length))
      .filter((item): item is string => typeof item === "string" && item.length > 0 && !item.startsWith(".")),
  ].sort((a, b) => a.localeCompare(b));

  return entries.join("\n");
}

async function checkPathExists(
  authId: string,
  path: string,
): Promise<{ exists: boolean; isDirectory: boolean }> {
  const normalizedPath = toScopedPath(path, authId);
  if (normalizedPath === "/") {
    return { exists: true, isDirectory: true };
  }

  const s3Key = toS3Key(normalizedPath, authId);

  try {
    await s3.send(new HeadObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: s3Key,
    }));
    return { exists: true, isDirectory: false };
  } catch {
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: s3Key.endsWith("/") ? s3Key : `${s3Key}/`,
      MaxKeys: 1,
    }));

    if ((listResponse.Contents ?? []).length > 0) {
      return { exists: true, isDirectory: true };
    }

    return { exists: false, isDirectory: false };
  }
}

async function deleteMemoryFile(params: {
  name: string;
  userId: string;
}): Promise<string> {
  const { name, userId: authId } = params;
  const path = toScopedPath(name, authId);
  if (path === "/") {
    return `Error: refusing to delete ${toVisiblePath(path, authId)}`;
  }

  const { exists, isDirectory } = await checkPathExists(authId, path);
  if (!exists) {
    return `Error: The path ${toVisiblePath(path, authId)} does not exist`;
  }

  if (isDirectory) {
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: `${toS3Key(path, authId)}/`,
    }));

    for (const item of listResponse.Contents ?? []) {
      if (!item.Key) continue;
      await s3.send(new DeleteObjectCommand({
        Bucket: AWS_S3_BUCKET,
        Key: item.Key,
      }));
    }
  } else {
    await s3.send(new DeleteObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: toS3Key(path, authId),
    }));
  }

  return `Successfully deleted ${toVisiblePath(path, authId)}`;
}

async function renameMemoryFile(params: {
  oldName: string;
  newName: string;
  userId: string;
}): Promise<string> {
  const { userId: authId } = params;
  const oldPath = toScopedPath(params.oldName, authId);
  const newPath = toScopedPath(params.newName, authId);
  if (oldPath === "/" || newPath === "/") {
    return `Error: cannot rename ${toVisiblePath("/", authId)}`;
  }

  const { exists: sourceExists, isDirectory: sourceIsDirectory } = await checkPathExists(authId, oldPath);
  if (!sourceExists) {
    return `Error: The path ${toVisiblePath(oldPath, authId)} does not exist`;
  }

  const { exists: destinationExists } = await checkPathExists(authId, newPath);
  if (destinationExists) {
    return `Error: The destination ${toVisiblePath(newPath, authId)} already exists`;
  }

  if (sourceIsDirectory) {
    const oldPrefix = `${toS3Key(oldPath, authId)}/`;
    const newPrefix = `${toS3Key(newPath, authId)}/`;
    const listResponse = await s3.send(new ListObjectsV2Command({
      Bucket: AWS_S3_BUCKET,
      Prefix: oldPrefix,
    }));

    for (const item of listResponse.Contents ?? []) {
      if (!item.Key) continue;

      const newKey = item.Key.replace(oldPrefix, newPrefix);
      await s3.send(new CopyObjectCommand({
        Bucket: AWS_S3_BUCKET,
        CopySource: `${AWS_S3_BUCKET}/${item.Key}`,
        Key: newKey,
      }));
      await s3.send(new DeleteObjectCommand({
        Bucket: AWS_S3_BUCKET,
        Key: item.Key,
      }));
    }
  } else {
    const oldKey = toS3Key(oldPath, authId);
    const newKey = toS3Key(newPath, authId);

    await s3.send(new CopyObjectCommand({
      Bucket: AWS_S3_BUCKET,
      CopySource: `${AWS_S3_BUCKET}/${oldKey}`,
      Key: newKey,
    }));
    await s3.send(new DeleteObjectCommand({
      Bucket: AWS_S3_BUCKET,
      Key: oldKey,
    }));
  }

  return `Successfully renamed ${toVisiblePath(oldPath, authId)} to ${toVisiblePath(newPath, authId)}`;
}
