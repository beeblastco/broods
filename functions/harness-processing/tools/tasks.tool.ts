/**
 * Task-list tool backed by the virtual filesystem.
 * Keep task titles and task status management here.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
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

const taskInputSchema = {
  type: "object",
  properties: {
    command: {
      type: "string",
      enum: ["create", "list", "update"],
      description: "Task command to run.",
    },
    title: {
      type: "string",
      description: "Title of the task list.",
    },
    tasks: {
      type: "array",
      items: { type: "string" },
      description: "Task names to create under the title.",
    },
    done: {
      type: "array",
      items: { type: "string" },
      description: "Task names to mark done under the title.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

interface TaskInput {
  command: "create" | "list" | "update";
  title?: string;
  tasks?: string[];
  done?: string[];
}

interface TaskLine {
  checked: boolean;
  text: string;
}

interface TaskDocument {
  key: string;
  title: string;
  tasks: TaskLine[];
}

export default function tasksTool(context: ToolContext): ToolSet {
  const namespace = normalizeFilesystemNamespace(context.conversationKey);

  return {
    tasks: tool({
      description: "Create, list, and update task lists by title.",
      inputSchema: jsonSchema(taskInputSchema),
      async execute(input) {
        try {
          const taskInput = input as TaskInput;

          switch (taskInput.command) {
            case "create":
              return {
                type: "text",
                value: await createTaskList(namespace, taskInput.title, taskInput.tasks ?? []),
              };
            case "list":
              return {
                type: "text",
                value: await listTaskLists(namespace),
              };
            case "update":
              return {
                type: "text",
                value: await updateTaskList(namespace, taskInput.title, taskInput.done ?? []),
              };
            default:
              return {
                type: "error-text",
                value: "Error: unsupported task command",
              };
          }
        } catch (error) {
          return {
            type: "error-text",
            value: error instanceof Error ? error.message : String(error),
          };
        }
      },
    }),
  };
}

async function createTaskList(namespace: string, title: string | undefined, tasks: string[]): Promise<string> {
  const normalizedTitle = title?.trim();
  if (!normalizedTitle) {
    return "Error: title is required for create";
  }

  const cleanedTasks = tasks
    .map((task) => task.trim())
    .filter(Boolean);

  if (cleanedTasks.length === 0) {
    return "Error: tasks must include at least one task item";
  }

  const existing = await findTaskDocumentByTitle(namespace, normalizedTitle);
  if (existing) {
    return `Error: a task list named "${normalizedTitle}" already exists`;
  }

  const key = `${namespace}/tasks-${crypto.randomUUID().slice(0, 8)}.md`;
  const body = serializeTaskDocument(normalizedTitle, cleanedTasks.map((task) => ({
    checked: false,
    text: task,
  })));

  await writeObject(key, body);

  return renderTaskDocument({
    key,
    title: normalizedTitle,
    tasks: cleanedTasks.map((task) => ({ checked: false, text: task })),
  }, `Created task list "${normalizedTitle}"`);
}

async function listTaskLists(namespace: string): Promise<string> {
  const documents = await listTaskDocuments(namespace);
  if (documents.length === 0) {
    return "No task lists found";
  }

  return documents.map((document) => renderTaskDocument(document)).join("\n\n");
}

async function updateTaskList(namespace: string, title: string | undefined, done: string[]): Promise<string> {
  const normalizedTitle = title?.trim();
  if (!normalizedTitle) {
    return "Error: title is required for update";
  }

  const cleanedDone = done
    .map((task) => task.trim())
    .filter(Boolean);

  if (cleanedDone.length === 0) {
    return "Error: done must include at least one task name";
  }

  const document = await findTaskDocumentByTitle(namespace, normalizedTitle);
  if (!document) {
    return `Error: task list "${normalizedTitle}" was not found`;
  }

  const taskMap = new Map(document.tasks.map((task) => [task.text, task]));
  for (const taskName of cleanedDone) {
    if (!taskMap.has(taskName)) {
      return `Error: task "${taskName}" was not found in "${normalizedTitle}"`;
    }
  }

  const doneSet = new Set(cleanedDone);
  const updatedTasks = document.tasks.map((task) => ({
    ...task,
    checked: task.checked || doneSet.has(task.text),
  }));

  if (updatedTasks.every((task) => task.checked)) {
    await s3.send(new DeleteObjectCommand({
      Bucket: FILESYSTEM_BUCKET_NAME,
      Key: document.key,
    }));

    return `All tasks in "${normalizedTitle}" are done. Removed the task list.`;
  }

  await writeObject(document.key, serializeTaskDocument(normalizedTitle, updatedTasks));

  return renderTaskDocument({
    ...document,
    title: normalizedTitle,
    tasks: updatedTasks,
  }, `Updated task list "${normalizedTitle}"`);
}

async function listTaskDocuments(namespace: string): Promise<TaskDocument[]> {
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Prefix: `${namespace}/tasks-`,
  }));

  const keys = (response.Contents ?? [])
    .map((item) => item.Key)
    .filter((key): key is string => typeof key === "string" && isTaskKey(namespace, key))
    .sort((a, b) => a.localeCompare(b));

  const documents = await Promise.all(keys.map(async (key) => parseTaskDocument(key, await readObject(key))));
  return documents.sort((a, b) => a.title.localeCompare(b.title));
}

async function findTaskDocumentByTitle(namespace: string, title: string): Promise<TaskDocument | null> {
  const documents = await listTaskDocuments(namespace);
  return documents.find((document) => document.title === title) ?? null;
}

function parseTaskDocument(key: string, content: string): TaskDocument {
  const lines = content.split("\n");
  const titleLine = lines.find((line) => line.startsWith("# "));
  if (!titleLine) {
    throw new Error(`Task list is missing a title: ${key.split("/").pop() ?? key}`);
  }

  const title = titleLine.slice(2).trim();
  const tasks = lines
    .map((line) => line.match(/^\s*-\s+\[([ xX])\]\s+(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      checked: match[1]!.toLowerCase() === "x",
      text: match[2]!.trim(),
    }));

  return { key, title, tasks };
}

function renderTaskDocument(document: TaskDocument, prefix?: string): string {
  const lines = document.tasks.length === 0
    ? ["(empty task list)"]
    : document.tasks.map((task) => `- [${task.checked ? "x" : " "}] ${task.text}`);

  const heading = prefix ? `${prefix}\n${document.title}` : document.title;
  return `${heading}\n${lines.join("\n")}`;
}

function serializeTaskDocument(title: string, tasks: TaskLine[]): string {
  return [
    `# ${title}`,
    "",
    ...tasks.map((task) => `- [${task.checked ? "x" : " "}] ${task.text}`),
  ].join("\n");
}

async function readObject(key: string): Promise<string> {
  const response = await s3.send(new GetObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: key,
  }));

  return await response.Body?.transformToString() ?? "";
}

async function writeObject(key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: FILESYSTEM_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: "text/markdown",
  }));
}

function isTaskKey(namespace: string, key: string): boolean {
  const prefix = `${namespace}/`;
  if (!key.startsWith(prefix)) {
    return false;
  }

  const fileName = key.slice(prefix.length);
  return /^tasks-[a-z0-9]{8}\.md$/i.test(fileName);
}
