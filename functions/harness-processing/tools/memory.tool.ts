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

type MemoryCommand = "view" | "create" | "str_replace" | "insert" | "delete" | "rename";

interface MemoryInput {
  command: MemoryCommand;
  path?: string;
  view_range?: { start: number; end: number };
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  insert_text?: string;
  old_path?: string;
  new_path?: string;
}

type CommandResult = { result: string; isError: boolean };
type CommandHandler = (input: MemoryInput, authId: string) => Promise<CommandResult>;

const memoryInputSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["view", "create", "str_replace", "insert", "delete", "rename"],
      description: `The memory command to execute.
- view: View file contents with line numbers, or list directory contents
- create: Create a new file with specified content
- str_replace: Replace unique text in a file
- insert: Insert text at a specific line number
- delete: Delete a file or directory
- rename: Rename or move a file or directory`,
    },
    path: {
      type: "string",
      description: "Path to file or directory. Must start with /memories.",
    },
    view_range: {
      type: "object",
      properties: {
        start: { type: "number", description: "Start line number (1-indexed)" },
        end: { type: "number", description: "End line number (1-indexed)" },
      },
      required: ["start", "end"],
      additionalProperties: false,
      description: "Optional line range for the view command.",
    },
    file_text: {
      type: "string",
      description: "Full file contents for the create command.",
    },
    old_str: {
      type: "string",
      description: "Existing text to replace for the str_replace command.",
    },
    new_str: {
      type: "string",
      description: "Replacement text for the str_replace command.",
    },
    insert_line: {
      type: "number",
      description: "Line index to insert at. Use 0 to insert at the beginning.",
    },
    insert_text: {
      type: "string",
      description: "Text to insert for the insert command.",
    },
    old_path: {
      type: "string",
      description: "Existing file or directory path for the rename command.",
    },
    new_path: {
      type: "string",
      description: "Destination path for the rename command.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const error = (result: string): CommandResult => ({ result, isError: true });
const success = (result: string): CommandResult => ({ result, isError: false });

const commandHandlers: Record<MemoryCommand, CommandHandler> = {
  view: async (input, authId) => {
    if (!input.path) {
      return error("Error: path is required for view command");
    }

    const viewRange = input.view_range
      ? [input.view_range.start, input.view_range.end] as [number, number]
      : undefined;

    return success(await viewMemoryFile({
      name: input.path,
      userId: authId,
      viewRange,
    }));
  },

  create: async (input, authId) => {
    if (!input.path || input.file_text === undefined) {
      return error("Error: path and file_text are required for create command");
    }

    return success(await createMemoryFile({
      name: input.path,
      fileText: input.file_text,
      userId: authId,
    }));
  },

  str_replace: async (input, authId) => {
    if (!input.path || !input.old_str || input.new_str === undefined) {
      return error("Error: path, old_str, and new_str are required for str_replace command");
    }

    return success(await strReplaceMemory({
      name: input.path,
      oldStr: input.old_str,
      newStr: input.new_str,
      userId: authId,
    }));
  },

  insert: async (input, authId) => {
    if (!input.path || input.insert_line === undefined || input.insert_text === undefined) {
      return error("Error: path, insert_line, and insert_text are required for insert command");
    }

    return success(await insertAtLineMemory({
      name: input.path,
      insertLine: input.insert_line,
      insertText: input.insert_text,
      userId: authId,
    }));
  },

  delete: async (input, authId) => {
    if (!input.path) {
      return error("Error: path is required for delete command");
    }

    return success(await deleteMemoryFile({
      name: input.path,
      userId: authId,
    }));
  },

  rename: async (input, authId) => {
    if (!input.old_path || !input.new_path) {
      return error("Error: old_path and new_path are required for rename command");
    }

    return success(await renameMemoryFile({
      oldName: input.old_path,
      newName: input.new_path,
      userId: authId,
    }));
  },
};

export default function memoryTool(_context: ToolContext): ToolSet {
  const memoryNamespace = normalizeMemoryNamespace(_context.conversationKey);

  return {
    memory: tool({
      description: `Persistent memory storage tool for reading and writing files. All paths must start with /memories.

Use this tool to remember user information, store notes and preferences, and manage durable task files.`,
      inputSchema: jsonSchema(memoryInputSchema),
      async execute(input) {
        const handler = commandHandlers[(input as MemoryInput).command];
        const { result, isError } = await handler(input as MemoryInput, memoryNamespace);
        return { type: isError ? "error-text" : "text", value: result };
      },
    }),
  };
}

function normalizeMemoryNamespace(conversationKey: string): string {
  return conversationKey
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}

function toS3Key(path: string, authId: string): string {
  if (!path.startsWith("/memories")) {
    throw new Error("Invalid path: must start with /memories");
  }

  if (path.includes("../") || path.includes("..\\") || path.includes("%2e%2e")) {
    throw new Error("Invalid path: directory traversal not allowed");
  }

  const relativePath = path.slice("/memories".length);
  const s3Key = `${authId}/memories${relativePath}`;

  if (!s3Key.startsWith(`${authId}/memories`)) {
    throw new Error("Invalid path: resolved outside memory directory");
  }

  return s3Key;
}

function toMemoryPath(s3Key: string, authId: string): string {
  const prefix = `${authId}/memories`;
  return s3Key.startsWith(prefix) ? `/memories${s3Key.slice(prefix.length)}` : s3Key;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function formatLineNumber(lineNum: number): string {
  return lineNum.toString().padStart(6, " ");
}

async function checkPathExists(
  authId: string,
  path: string,
): Promise<{ exists: boolean; isDirectory: boolean }> {
  const s3Key = toS3Key(path, authId);

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

async function listDirectory(params: { path: string; authId: string }): Promise<string> {
  const { path, authId } = params;
  const s3Prefix = path === "/memories" || path === "/memories/"
    ? `${authId}/memories/`
    : `${toS3Key(path, authId)}/`;

  const response = await s3.send(new ListObjectsV2Command({
    Bucket: AWS_S3_BUCKET,
    Prefix: s3Prefix,
  }));

  const items = response.Contents ?? [];
  if (items.length === 0) {
    return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:\n0\t${path}`;
  }

  let totalSize = 0;
  const fileEntries: { path: string; size: number }[] = [];

  for (const item of items) {
    if (!item.Key) continue;
    const filename = item.Key.split("/").pop();
    if (filename?.startsWith(".")) continue;

    const size = item.Size ?? 0;
    totalSize += size;

    const memoryPath = toMemoryPath(item.Key, authId);
    const relativePath = memoryPath.slice("/memories".length + 1);
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length <= 2) {
      fileEntries.push({ path: memoryPath, size });
    }
  }

  const lines = [
    `${formatSize(totalSize)}\t${path}`,
    ...fileEntries.map((entry) => `${formatSize(entry.size)}\t${entry.path}`),
  ];

  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:\n${lines.join("\n")}`;
}

async function viewMemoryFile(params: {
  name: string;
  userId: string;
  viewRange?: [number, number];
}): Promise<string> {
  const { name: path, userId: authId, viewRange } = params;

  if (path === "/memories" || path === "/memories/") {
    return listDirectory({ path, authId });
  }

  const { exists, isDirectory } = await checkPathExists(authId, path);
  if (!exists) {
    return `The path ${path} does not exist. Please provide a valid path.`;
  }

  if (isDirectory) {
    return listDirectory({ path, authId });
  }

  const s3Key = toS3Key(path, authId);
  const response = await s3.send(new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: s3Key,
  }));

  const content = await response.Body?.transformToString() ?? "";
  const lines = content.split("\n");
  if (lines.length > 999999) {
    return `File ${path} exceeds maximum line limit of 999,999 lines.`;
  }

  let startLine = 1;
  let endLine = lines.length;
  if (viewRange) {
    startLine = Math.max(1, viewRange[0]);
    endLine = Math.min(lines.length, viewRange[1]);
  }

  const formattedLines = lines
    .slice(startLine - 1, endLine)
    .map((line, index) => `${formatLineNumber(startLine + index)}\t${line}`)
    .join("\n");

  return `Here's the content of ${path} with line numbers:\n${formattedLines}`;
}

async function createMemoryFile(params: {
  name: string;
  fileText: string;
  userId: string;
}): Promise<string> {
  const { name: path, fileText, userId: authId } = params;
  const { exists } = await checkPathExists(authId, path);
  if (exists) {
    return `Error: File ${path} already exists`;
  }

  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: toS3Key(path, authId),
    Body: fileText,
    ContentType: "text/plain",
  }));

  return `File created successfully at: ${path}`;
}

async function strReplaceMemory(params: {
  name: string;
  oldStr: string;
  newStr: string;
  userId: string;
}): Promise<string> {
  const { name: path, oldStr, newStr, userId: authId } = params;
  const { exists, isDirectory } = await checkPathExists(authId, path);
  if (!exists || isDirectory) {
    return `Error: The path ${path} does not exist. Please provide a valid path.`;
  }

  const s3Key = toS3Key(path, authId);
  const response = await s3.send(new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: s3Key,
  }));

  const content = await response.Body?.transformToString() ?? "";
  const lines = content.split("\n");
  const matchingLines: number[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.includes(oldStr)) {
      matchingLines.push(index + 1);
    }
  }

  const matches = content.split(oldStr).length - 1;
  if (matches === 0) {
    return `No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${path}.`;
  }

  if (matches > 1) {
    return `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines: ${matchingLines.join(", ")}. Please ensure it is unique`;
  }

  const newContent = content.replace(oldStr, newStr);
  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: s3Key,
    Body: newContent,
    ContentType: "text/plain",
  }));

  const newLines = newContent.split("\n");
  const replacementLineIndex = newLines.findIndex((line) => line.includes(newStr));
  const snippetStart = Math.max(0, replacementLineIndex - 2);
  const snippetEnd = Math.min(newLines.length, replacementLineIndex + 3);
  const snippet = newLines
    .slice(snippetStart, snippetEnd)
    .map((line, index) => `${formatLineNumber(snippetStart + index + 1)}\t${line}`)
    .join("\n");

  return `The memory file has been edited.\n${snippet}`;
}

async function insertAtLineMemory(params: {
  name: string;
  insertLine: number;
  insertText: string;
  userId: string;
}): Promise<string> {
  const { name: path, insertLine, insertText, userId: authId } = params;
  const { exists, isDirectory } = await checkPathExists(authId, path);
  if (!exists || isDirectory) {
    return `Error: The path ${path} does not exist`;
  }

  const s3Key = toS3Key(path, authId);
  const response = await s3.send(new GetObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: s3Key,
  }));

  const content = await response.Body?.transformToString() ?? "";
  const lines = content.split("\n");
  if (insertLine < 0 || insertLine > lines.length) {
    return `Error: Invalid \`insert_line\` parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`;
  }

  lines.splice(insertLine, 0, ...insertText.split("\n"));

  await s3.send(new PutObjectCommand({
    Bucket: AWS_S3_BUCKET,
    Key: s3Key,
    Body: lines.join("\n"),
    ContentType: "text/plain",
  }));

  return `The file ${path} has been edited.`;
}

async function deleteMemoryFile(params: {
  name: string;
  userId: string;
}): Promise<string> {
  const { name: path, userId: authId } = params;
  const { exists, isDirectory } = await checkPathExists(authId, path);
  if (!exists) {
    return `Error: The path ${path} does not exist`;
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

  return `Successfully deleted ${path}`;
}

async function renameMemoryFile(params: {
  oldName: string;
  newName: string;
  userId: string;
}): Promise<string> {
  const { oldName: oldPath, newName: newPath, userId: authId } = params;
  const { exists: sourceExists, isDirectory: sourceIsDirectory } = await checkPathExists(authId, oldPath);
  if (!sourceExists) {
    return `Error: The path ${oldPath} does not exist`;
  }

  const { exists: destinationExists } = await checkPathExists(authId, newPath);
  if (destinationExists) {
    return `Error: The destination ${newPath} already exists`;
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

  return `Successfully renamed ${oldPath} to ${newPath}`;
}
