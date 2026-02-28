import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { tool } from "ai";
import { posix } from "node:path";
import { z } from "zod";
import { toErrorMessage } from "./utils";

/** S3 client for agent memory storage (filesystem-like, namespaced by authId). */
const memoryS3Client = new S3Client({ region: Bun.env.AWS_REGION });
const memoryS3Bucket = Bun.env.AWS_S3_BUCKET ?? "";

/**
 * Converts a memory path to a namespaced S3 key for a given user.
 * @param path Memory path starting with /memories
 * @param authId User auth ID for namespace isolation
 * @returns S3 key string
 */
function memoryPathToS3Key(path: string, authId: string): string {
  if (!path.startsWith("/memories")) {
    throw new Error("Invalid path: must start with /memories");
  }

  // Normalize the path to resolve any traversal sequences (../, .., encoded variants)
  const decoded = decodeURIComponent(path);
  const normalized = posix.normalize(decoded);

  // After normalization, the path must still be within /memories
  if (!normalized.startsWith("/memories")) {
    throw new Error("Invalid path: resolved outside memory directory");
  }

  const s3Key = `${authId}${normalized}`;

  return s3Key;
}

/**
 * Converts a namespaced S3 key back to a memory path.
 * @param s3Key S3 object key
 * @param authId User auth ID
 * @returns Memory path string
 */
function s3KeyToMemoryPath(s3Key: string, authId: string): string {
  const prefix = `${authId}/memories`;

  return s3Key.startsWith(prefix) ? `/memories${s3Key.slice(prefix.length)}` : s3Key;
}

/**
 * Formats a byte count as a human-readable size string.
 * @param bytes Byte count
 * @returns Formatted size string (e.g., "5.5K", "1.2M")
 */
function formatMemorySize(bytes: number): string {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;

  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * Checks whether a memory path exists as a file or directory in S3.
 * @param authId User auth ID
 * @param path Memory path
 * @returns Object with exists and isDirectory flags
 */
async function checkMemoryPath(
  authId: string,
  path: string,
): Promise<{ exists: boolean; isDirectory: boolean }> {
  const s3Key = memoryPathToS3Key(path, authId);

  try {
    await memoryS3Client.send(new HeadObjectCommand({ Bucket: memoryS3Bucket, Key: s3Key }));

    return { exists: true, isDirectory: false };
  } catch { /* not a file, check for directory prefix */ }

  const res = await memoryS3Client.send(
    new ListObjectsV2Command({
      Bucket: memoryS3Bucket,
      Prefix: s3Key.endsWith("/") ? s3Key : `${s3Key}/`,
      MaxKeys: 1,
    }),
  );
  const isDir = (res.Contents?.length ?? 0) > 0;

  return { exists: isDir, isDirectory: isDir };
}

/**
 * Lists memory directory contents up to 2 levels deep.
 * @param authId User auth ID
 * @param path Directory memory path
 * @returns Formatted directory listing
 */
async function listMemoryDir(authId: string, path: string): Promise<string> {
  const prefix =
    path === "/memories" || path === "/memories/"
      ? `${authId}/memories/`
      : `${memoryPathToS3Key(path, authId)}/`;

  const res = await memoryS3Client.send(
    new ListObjectsV2Command({ Bucket: memoryS3Bucket, Prefix: prefix }),
  );
  const items = res.Contents ?? [];

  if (items.length === 0) {
    return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items:\n0\t${path}`;
  }

  let totalSize = 0;
  const entries: { path: string; size: number }[] = [];

  for (const item of items) {
    if (!item.Key) continue;
    const filename = item.Key.split("/").pop();
    if (filename?.startsWith(".")) continue;
    const size = item.Size ?? 0;
    totalSize += size;
    const memPath = s3KeyToMemoryPath(item.Key, authId);
    const relative = memPath.slice("/memories".length + 1);
    if (relative.split("/").filter(Boolean).length <= 2) {
      entries.push({ path: memPath, size: size });
    }
  }

  const lines = [
    `${formatMemorySize(totalSize)}\t${path}`,
    ...entries.map((e) => `${formatMemorySize(e.size)}\t${e.path}`),
  ];

  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items:\n${lines.join("\n")}`;
}

/**
 * Dispatches a memory command to its S3 implementation.
 * @param input Memory command input
 * @param authId User auth ID
 * @returns Result string
 */
async function executeMemoryCommand(
  input: {
    command: "view" | "create" | "str_replace" | "insert" | "delete" | "rename";
    path?: string;
    view_range?: { start: number; end: number };
    file_text?: string;
    old_str?: string;
    new_str?: string;
    insert_line?: number;
    insert_text?: string;
    old_path?: string;
    new_path?: string;
  },
  authId: string,
): Promise<string> {
  const { command } = input;

  if (command === "view") {
    if (!input.path) return "Error: path is required for view command";
    const path = input.path;
    if (path === "/memories" || path === "/memories/") return listMemoryDir(authId, path);
    const { exists, isDirectory } = await checkMemoryPath(authId, path);
    if (!exists) return `The path ${path} does not exist.`;
    if (isDirectory) return listMemoryDir(authId, path);
    const res = await memoryS3Client.send(
      new GetObjectCommand({ Bucket: memoryS3Bucket, Key: memoryPathToS3Key(path, authId) }),
    );
    const content = (await res.Body?.transformToString()) ?? "";
    const lines = content.split("\n");
    const start = input.view_range ? Math.max(1, input.view_range.start) : 1;
    const end = input.view_range ? Math.min(lines.length, input.view_range.end) : lines.length;
    const formatted = lines
      .slice(start - 1, end)
      .map((line, idx) => `${String(start + idx).padStart(6, " ")}\t${line}`)
      .join("\n");

    return `Here's the content of ${path} with line numbers:\n${formatted}`;
  }

  if (command === "create") {
    if (!input.path || input.file_text === undefined) {
      return "Error: path and file_text are required for create command";
    }
    const { exists } = await checkMemoryPath(authId, input.path);
    if (exists) return `Error: File ${input.path} already exists`;
    await memoryS3Client.send(
      new PutObjectCommand({
        Bucket: memoryS3Bucket,
        Key: memoryPathToS3Key(input.path, authId),
        Body: input.file_text,
        ContentType: "text/plain",
      }),
    );

    return `File created successfully at: ${input.path}`;
  }

  if (command === "str_replace") {
    if (!input.path || !input.old_str || input.new_str === undefined) {
      return "Error: path, old_str, and new_str are required for str_replace command";
    }
    const { exists, isDirectory } = await checkMemoryPath(authId, input.path);
    if (!exists || isDirectory) return `Error: The path ${input.path} does not exist.`;
    const s3Key = memoryPathToS3Key(input.path, authId);
    const res = await memoryS3Client.send(new GetObjectCommand({ Bucket: memoryS3Bucket, Key: s3Key }));
    const content = (await res.Body?.transformToString()) ?? "";
    const matches = content.split(input.old_str).length - 1;
    if (matches === 0) {
      return `No replacement was performed, old_str did not appear verbatim in ${input.path}.`;
    }
    if (matches > 1) {
      return `No replacement was performed. Multiple occurrences of old_str in ${input.path}. Please ensure it is unique.`;
    }
    const newContent = content.replace(input.old_str, input.new_str);
    await memoryS3Client.send(
      new PutObjectCommand({ Bucket: memoryS3Bucket, Key: s3Key, Body: newContent, ContentType: "text/plain" }),
    );
    const newLines = newContent.split("\n");
    const replacementLine = newLines.findIndex((l) => l.includes(input.new_str!));
    const snippetStart = Math.max(0, replacementLine - 2);
    const snippet = newLines
      .slice(snippetStart, Math.min(newLines.length, replacementLine + 3))
      .map((l, i) => `${String(snippetStart + i + 1).padStart(6, " ")}\t${l}`)
      .join("\n");

    return `The memory file has been edited.\n${snippet}`;
  }

  if (command === "insert") {
    if (!input.path || input.insert_line === undefined || input.insert_text === undefined) {
      return "Error: path, insert_line, and insert_text are required for insert command";
    }
    const { exists, isDirectory } = await checkMemoryPath(authId, input.path);
    if (!exists || isDirectory) return `Error: The path ${input.path} does not exist`;
    const s3Key = memoryPathToS3Key(input.path, authId);
    const res = await memoryS3Client.send(new GetObjectCommand({ Bucket: memoryS3Bucket, Key: s3Key }));
    const content = (await res.Body?.transformToString()) ?? "";
    const lines = content.split("\n");
    if (input.insert_line < 0 || input.insert_line > lines.length) {
      return `Error: Invalid insert_line ${input.insert_line}. Must be between 0 and ${lines.length}.`;
    }
    lines.splice(input.insert_line, 0, ...input.insert_text.split("\n"));
    await memoryS3Client.send(
      new PutObjectCommand({ Bucket: memoryS3Bucket, Key: s3Key, Body: lines.join("\n"), ContentType: "text/plain" }),
    );

    return `The file ${input.path} has been edited.`;
  }

  if (command === "delete") {
    if (!input.path) return "Error: path is required for delete command";
    const { exists, isDirectory } = await checkMemoryPath(authId, input.path);
    if (!exists) return `Error: The path ${input.path} does not exist`;
    if (isDirectory) {
      const s3Prefix = `${memoryPathToS3Key(input.path, authId)}/`;
      const listRes = await memoryS3Client.send(
        new ListObjectsV2Command({ Bucket: memoryS3Bucket, Prefix: s3Prefix }),
      );
      for (const item of listRes.Contents ?? []) {
        if (item.Key) {
          await memoryS3Client.send(new DeleteObjectCommand({ Bucket: memoryS3Bucket, Key: item.Key }));
        }
      }
    } else {
      await memoryS3Client.send(
        new DeleteObjectCommand({ Bucket: memoryS3Bucket, Key: memoryPathToS3Key(input.path, authId) }),
      );
    }

    return `Successfully deleted ${input.path}`;
  }

  if (command === "rename") {
    if (!input.old_path || !input.new_path) {
      return "Error: old_path and new_path are required for rename command";
    }
    const { exists: srcExists, isDirectory: srcIsDir } = await checkMemoryPath(authId, input.old_path);
    if (!srcExists) return `Error: The path ${input.old_path} does not exist`;
    const { exists: dstExists } = await checkMemoryPath(authId, input.new_path);
    if (dstExists) return `Error: The destination ${input.new_path} already exists`;
    if (srcIsDir) {
      const oldPrefix = `${memoryPathToS3Key(input.old_path, authId)}/`;
      const newPrefix = `${memoryPathToS3Key(input.new_path, authId)}/`;
      const listRes = await memoryS3Client.send(
        new ListObjectsV2Command({ Bucket: memoryS3Bucket, Prefix: oldPrefix }),
      );
      for (const item of listRes.Contents ?? []) {
        if (!item.Key) continue;
        const newKey = item.Key.replace(oldPrefix, newPrefix);
        await memoryS3Client.send(
          new CopyObjectCommand({ Bucket: memoryS3Bucket, CopySource: `${memoryS3Bucket}/${item.Key}`, Key: newKey }),
        );
        await memoryS3Client.send(new DeleteObjectCommand({ Bucket: memoryS3Bucket, Key: item.Key }));
      }
    } else {
      const oldKey = memoryPathToS3Key(input.old_path, authId);
      const newKey = memoryPathToS3Key(input.new_path, authId);
      await memoryS3Client.send(
        new CopyObjectCommand({ Bucket: memoryS3Bucket, CopySource: `${memoryS3Bucket}/${oldKey}`, Key: newKey }),
      );
      await memoryS3Client.send(new DeleteObjectCommand({ Bucket: memoryS3Bucket, Key: oldKey }));
    }

    return `Successfully renamed ${input.old_path} to ${input.new_path}`;
  }

  return "Unknown command.";
}

/**
 * Creates a filesystem-like S3-backed memory tool for the agent.
 * Supports view, create, str_replace, insert, delete, and rename operations on /memories/* paths.
 * @param authId User auth ID for namespacing S3 keys
 * @returns AI SDK tool instance
 */
export function createMemoryTool(authId: string) {
  return tool({
    description: [
      "Persistent memory storage tool for reading and writing files. All paths must start with /memories.",
      "",
      "Use this tool to:",
      "- Remember important information about the user",
      "- Store notes, preferences, and context across conversations",
      "- Manage tasks that need to be done",
      "- Organize memories in directories (e.g., /memories/preferences.txt, /memories/notes/meeting.txt)",
    ].join("\n"),
    inputSchema: z.object({
      command: z
        .enum(["view", "create", "str_replace", "insert", "delete", "rename"])
        .describe(
          [
            "The memory command to execute.",
            "- view: View file contents with line numbers, or list directory contents",
            "- create: Create a new file with specified content",
            "- str_replace: Replace unique text in a file",
            "- insert: Insert text at a specific line number (0 = beginning)",
            "- delete: Delete a file or directory",
            "- rename: Rename or move a file/directory",
          ].join("\n"),
        ),
      path: z
        .string()
        .optional()
        .describe("Path to file or directory (must start with /memories). Required for: view, create, str_replace, insert, delete"),
      view_range: z
        .object({
          start: z.number().int().describe("Start line (1-indexed)"),
          end: z.number().int().describe("End line (1-indexed)"),
        })
        .optional()
        .describe("Optional line range for view command"),
      file_text: z.string().optional().describe("Content for the new file. Required for: create"),
      old_str: z.string().optional().describe("Text to find and replace (must be unique). Required for: str_replace"),
      new_str: z.string().optional().describe("Replacement text. Required for: str_replace"),
      insert_line: z.number().optional().describe("Line number to insert at (0 = beginning). Required for: insert"),
      insert_text: z.string().optional().describe("Text to insert. Required for: insert"),
      old_path: z.string().optional().describe("Current path. Required for: rename"),
      new_path: z.string().optional().describe("New path. Required for: rename"),
    }),
    execute: async (input): Promise<ToolResultOutput> => {
      try {
        const result = await executeMemoryCommand(input, authId);

        return { type: "text", value: result };
      } catch (err) {
        return { type: "error-text", value: toErrorMessage(err) };
      }
    },
  });
}
