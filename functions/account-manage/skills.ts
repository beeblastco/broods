/**
 * Account-management skill CRUD and import handling.
 * Keep model prompt loading in harness-processing and shared rules in _shared.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { deleteS3Prefix, listS3Prefix, s3ObjectExists, writeS3Object } from "../_shared/s3.ts";
import {
  formatSkillPath,
  normalizeBundlePath,
  parseGitHubSkillUrl,
  parseSkillMarkdown,
  readSkillMarkdown,
  skillsBucketName,
  SKILL_FILE,
  validateSkillDescription,
  validateSkillName,
  type SkillMetadata,
} from "../_shared/skills.ts";

const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".py", ".sh", ".sql", ".svg",
  ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

export interface SkillManifestFile {
  path: string;
  size?: number;
}

export interface SkillBundleFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}

export type CreateSkillInput =
  | { source: "json"; name: unknown; description: unknown; content: unknown }
  | { source: "files"; files: unknown }
  | { source: "github"; url: unknown };

export interface StoredSkill extends SkillMetadata {
  files: SkillManifestFile[];
}

export type { SkillMetadata } from "../_shared/skills.ts";

export async function createOrReplaceSkill(accountId: string, input: unknown): Promise<StoredSkill> {
  const files = await resolveSkillBundleFiles(input);
  const metadata = validateSkillBundle(files);
  const skillPath = formatSkillPath(accountId, metadata.name);

  await deleteS3Prefix(skillsBucketName(), `${skillPath}/`);
  await Promise.all(files.map((file) => writeS3Object(
    skillsBucketName(),
    `${skillPath}/${file.path}`,
    file.bytes,
    { contentType: file.contentType ?? contentTypeForPath(file.path) },
  )));

  return {
    ...metadata,
    skillPath,
    files: files.map((file) => ({ path: file.path, size: file.bytes.byteLength })),
  };
}

export async function listAccountSkills(accountId: string): Promise<SkillMetadata[]> {
  const skills = await Promise.all((await listAccountSkillNames(accountId)).map((skillName) =>
    getSkill(accountId, skillName).catch(() => null)
  ));

  return skills
    .filter((skill): skill is StoredSkill => skill !== null)
    .map(({ name, description, skillPath }) => ({ name, description, skillPath }));
}

export async function getSkill(accountId: string, skillName: string): Promise<StoredSkill | null> {
  validateSkillName(skillName);
  const skillPath = formatSkillPath(accountId, skillName);
  const skillFile = await readSkillMarkdown(accountId, skillName);
  if (skillFile == null) {
    return null;
  }

  const metadata = parseSkillMarkdown(skillFile);
  return {
    ...metadata,
    skillPath,
    files: await listSkillManifestFiles(skillPath),
  };
}

export async function deleteSkill(accountId: string, skillName: string): Promise<boolean> {
  validateSkillName(skillName);
  const skillPath = formatSkillPath(accountId, skillName);
  if (!await skillExists(skillPath)) {
    return false;
  }

  await deleteS3Prefix(skillsBucketName(), `${skillPath}/`);
  return true;
}

export async function deleteAccountSkills(accountId: string): Promise<number> {
  return deleteS3Prefix(skillsBucketName(), `${accountId}/`);
}

async function listAccountSkillNames(accountId: string): Promise<string[]> {
  const objects = await listS3Prefix(skillsBucketName(), `${accountId}/`);
  const skillNames = new Set<string>();
  for (const object of objects) {
    const [, skillName] = object.key.split("/");
    if (skillName) {
      skillNames.add(skillName);
    }
  }

  return [...skillNames];
}

async function listSkillManifestFiles(skillPath: string): Promise<SkillManifestFile[]> {
  const files = await listS3Prefix(skillsBucketName(), `${skillPath}/`);
  return files.map((file) => ({
    path: file.key.slice(`${skillPath}/`.length),
    ...(file.size !== undefined ? { size: file.size } : {}),
  }));
}

async function skillExists(skillPath: string): Promise<boolean> {
  return s3ObjectExists(skillsBucketName(), `${skillPath}/${SKILL_FILE}`);
}

async function resolveSkillBundleFiles(input: unknown): Promise<SkillBundleFile[]> {
  if (!input || typeof input !== "object") {
    throw new Error("Request body must be an object");
  }

  const record = input as CreateSkillInput;
  switch (record.source) {
    case "json":
      return createJsonSkillFiles(record);
    case "files":
      return createUploadedSkillFiles(record.files);
    case "github":
      return createGitHubSkillFiles(record.url);
    default:
      throw new Error("source must be one of: json, files, github");
  }
}

function createJsonSkillFiles(input: Extract<CreateSkillInput, { source: "json" }>): SkillBundleFile[] {
  if (typeof input.name !== "string" || typeof input.description !== "string" || typeof input.content !== "string") {
    throw new Error("JSON skills require name, description, and content strings");
  }
  validateSkillName(input.name);
  validateSkillDescription(input.description);
  const markdown = `---\nname: ${input.name}\ndescription: ${input.description}\n---\n\n${input.content.trim()}\n`;
  return [{
    path: SKILL_FILE,
    bytes: new TextEncoder().encode(markdown),
    contentType: "text/markdown; charset=utf-8",
  }];
}

function createUploadedSkillFiles(value: unknown): SkillBundleFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("files must be a non-empty array");
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Each file must be an object");
    }
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.path !== "string" || typeof candidate.contentBase64 !== "string") {
      throw new Error("Each file requires path and contentBase64");
    }
    return {
      path: normalizeBundlePath(candidate.path),
      bytes: Buffer.from(candidate.contentBase64, "base64"),
      ...(typeof candidate.contentType === "string" ? { contentType: candidate.contentType } : {}),
    };
  });
}

async function createGitHubSkillFiles(url: unknown): Promise<SkillBundleFile[]> {
  const parsed = parseGitHubSkillUrl(url);
  const response = await fetch(parsed.archiveUrl, {
    headers: {
      "User-Agent": "filthy-panty-skill-importer",
      "Accept": "application/x-gzip",
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to download GitHub skill archive: ${response.status}`);
  }

  const tmpRoot = path.join("/tmp", `skill-${randomUUID()}`);
  const extractRoot = path.join(tmpRoot, "archive");
  await mkdir(extractRoot, { recursive: true });
  try {
    const archive = new Bun.Archive(await response.blob(), { compress: "gzip" });
    await archive.extract(extractRoot);
    const [rootEntry] = await readdir(extractRoot);
    if (!rootEntry) {
      throw new Error("GitHub archive is empty");
    }
    const skillRoot = path.join(extractRoot, rootEntry, parsed.subdir);
    return readLocalBundleFiles(skillRoot);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
}

async function readLocalBundleFiles(root: string): Promise<SkillBundleFile[]> {
  const files: SkillBundleFile[] = [];
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = normalizeBundlePath(path.relative(root, absolute));
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push({
          path: relative,
          bytes: await readFile(absolute),
          contentType: contentTypeForPath(relative),
        });
      }
    }
  }
  await walk(root);
  return files;
}

function validateSkillBundle(files: SkillBundleFile[]): Omit<SkillMetadata, "skillPath"> {
  const normalized = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    file.path = normalizeBundlePath(file.path);
    if (normalized.has(file.path)) {
      throw new Error(`Duplicate skill file path: ${file.path}`);
    }
    normalized.add(file.path);
    totalBytes += file.bytes.byteLength;
    if (file.bytes.byteLength > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Skill file is too large: ${file.path}`);
    }
    if (!isSupportedTextFile(file.path, file.bytes)) {
      throw new Error(`Skill file must be a supported text file: ${file.path}`);
    }
  }
  if (totalBytes > MAX_SKILL_BUNDLE_BYTES) {
    throw new Error("Skill bundle exceeds 30 MB");
  }

  const skillFile = files.find((file) => file.path === SKILL_FILE);
  if (!skillFile) {
    throw new Error("Skill bundle must include SKILL.md at the root");
  }
  return parseSkillMarkdown(new TextDecoder().decode(skillFile.bytes));
}

function isSupportedTextFile(filePath: string, bytes: Uint8Array): boolean {
  if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return false;
  }
  return !bytes.includes(0);
}

function contentTypeForPath(filePath: string): string {
  return path.extname(filePath).toLowerCase() === ".json"
    ? "application/json"
    : "text/plain; charset=utf-8";
}
