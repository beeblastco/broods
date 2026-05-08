/**
 * Account-scoped skill bundle validation and S3 persistence.
 * Keep Skill file rules here; agent selection and prompt use live elsewhere.
 */

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deleteS3Prefix, listS3Prefix, readS3Text, s3ObjectExists, writeS3Object } from "./bun-s3.ts";
import { requireEnv } from "./env.ts";

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".py", ".sh", ".sql", ".svg",
  ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);

export interface SkillMetadata {
  name: string;
  description: string;
  skillPath: string;
}

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
  const objects = await listS3Prefix(skillsBucketName(), `${accountId}/`);
  const skillNames = new Set<string>();
  for (const object of objects) {
    const [, skillName] = object.key.split("/");
    if (skillName) {
      skillNames.add(skillName);
    }
  }

  const skills = await Promise.all([...skillNames].map((skillName) =>
    getSkill(accountId, skillName).catch(() => null)
  ));

  return skills
    .filter((skill): skill is StoredSkill => skill !== null)
    .map(({ name, description, skillPath }) => ({ name, description, skillPath }));
}

export async function getSkill(accountId: string, skillName: string): Promise<StoredSkill | null> {
  validateSkillName(skillName);
  const skillPath = formatSkillPath(accountId, skillName);
  const skillFile = await readS3Text(skillsBucketName(), `${skillPath}/${SKILL_FILE}`).catch(() => null);
  if (skillFile == null) {
    return null;
  }

  const metadata = parseSkillMarkdown(skillFile);
  const files = await listS3Prefix(skillsBucketName(), `${skillPath}/`);
  return {
    ...metadata,
    skillPath,
    files: files.map((file) => ({
      path: file.key.slice(`${skillPath}/`.length),
      ...(file.size !== undefined ? { size: file.size } : {}),
    })),
  };
}

export async function deleteSkill(accountId: string, skillName: string): Promise<boolean> {
  validateSkillName(skillName);
  const skillPath = formatSkillPath(accountId, skillName);
  const existed = await s3ObjectExists(skillsBucketName(), `${skillPath}/${SKILL_FILE}`);
  if (!existed) {
    return false;
  }

  await deleteS3Prefix(skillsBucketName(), `${skillPath}/`);
  return true;
}

export async function deleteAccountSkills(accountId: string): Promise<number> {
  return deleteS3Prefix(skillsBucketName(), `${accountId}/`);
}

export async function assertAccountOwnsSkillPath(accountId: string, skillPath: string): Promise<void> {
  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    throw new Error(`Invalid skill path: ${skillPath}`);
  }
  if (parsed.accountId !== accountId) {
    throw new SkillAuthorizationError(skillPath);
  }
  if (!await s3ObjectExists(skillsBucketName(), `${skillPath}/${SKILL_FILE}`)) {
    throw new SkillNotFoundError(skillPath);
  }
}

export async function listSkillMetadataForConfig(accountId: string, skillPaths: string[] = []): Promise<SkillMetadata[]> {
  const enabled: SkillMetadata[] = [];
  for (const skillPath of skillPaths) {
    await assertAccountOwnsSkillPath(accountId, skillPath);
    const parsed = parseSkillPath(skillPath)!;
    const skill = await getSkill(accountId, parsed.skillName);
    if (skill) {
      enabled.push({
        name: skill.name,
        description: skill.description,
        skillPath: skill.skillPath,
      });
    }
  }
  return enabled;
}

export async function loadSkillContent(skillPath: string, resourcePaths: string[] = []): Promise<{
  skillPath: string;
  skill: SkillMetadata;
  parts: Array<{ path: string; text: string }>;
  bytes: number;
}> {
  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    throw new Error(`Invalid skill path: ${skillPath}`);
  }

  const skillText = await readS3Text(skillsBucketName(), `${skillPath}/${SKILL_FILE}`);
  const skill = parseSkillMarkdown(skillText);
  const safeResourcePaths = resourcePaths.map(normalizeBundlePath).filter((resource) => resource !== SKILL_FILE);
  const resourceParts = await Promise.all(safeResourcePaths.map(async (resourcePath) => ({
    path: resourcePath,
    text: await readS3Text(skillsBucketName(), `${skillPath}/${resourcePath}`),
  })));
  const parts = [
    { path: SKILL_FILE, text: skillInstructionsFromMarkdown(skillText) },
    ...resourceParts,
  ];

  return {
    skillPath,
    skill: {
      ...skill,
      skillPath,
    },
    parts,
    bytes: parts.reduce((total, part) => total + Buffer.byteLength(part.text, "utf-8"), 0),
  };
}

export function parseSkillMarkdown(markdown: string): Omit<SkillMetadata, "skillPath"> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }

  const frontmatter = parseSimpleYamlFrontmatter(match[1]);
  const name = frontmatter.name;
  const description = frontmatter.description;
  validateSkillName(name);
  validateSkillDescription(description);
  return { name, description };
}

export function skillInstructionsFromMarkdown(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

export function parseGitHubSkillUrl(value: unknown): {
  owner: string;
  repo: string;
  ref: string;
  subdir: string;
  archiveUrl: string;
} {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("url must be a non-empty string");
  }

  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new Error("GitHub skill URL must use https://github.com");
  }
  if (/%2e/i.test(value.trim()) || value.trim().includes("..")) {
    throw new Error("Invalid skill file path: GitHub URL must not contain path traversal");
  }

  const [owner, repo, kind, ref, ...subdirParts] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || kind !== "tree" || !ref) {
    throw new Error("GitHub skill URL must be https://github.com/{owner}/{repo}/tree/{ref}/{path}");
  }
  assertSafeGitHubSegment(owner, "owner");
  assertSafeGitHubSegment(repo, "repo");
  assertSafeGitHubSegment(ref, "ref");
  const subdir = subdirParts.map((part) => normalizeBundlePath(part)).join("/");
  return {
    owner,
    repo,
    ref,
    subdir,
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
  };
}

export function parseSkillPath(skillPath: string): { accountId: string; skillName: string } | null {
  const parts = skillPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  try {
    validateSkillName(parts[1]);
  } catch {
    return null;
  }
  return {
    accountId: parts[0],
    skillName: parts[1],
  };
}

export function formatSkillPath(accountId: string, skillName: string): string {
  validateSkillName(skillName);
  return `${accountId}/${skillName}`;
}

export class SkillAuthorizationError extends Error {
  constructor(public readonly skillPath: string) {
    super(`Skill path belongs to another account: ${skillPath}`);
  }
}

export class SkillNotFoundError extends Error {
  constructor(public readonly skillPath: string) {
    super(`Skill not found: ${skillPath}`);
  }
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

function normalizeBundlePath(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Skill file path must be a string");
  }

  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`Invalid skill file path: ${value}`);
  }
  return trimmed;
}

function validateSkillName(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_SKILL_NAME_LENGTH ||
    !/^[a-z0-9-]+$/.test(value) ||
    value.includes("anthropic") ||
    value.includes("claude") ||
    /<[^>]*>/.test(value)
  ) {
    throw new Error("Skill name must be lowercase letters, numbers, and hyphens only, max 64 chars, without reserved words");
  }
}

function validateSkillDescription(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_SKILL_DESCRIPTION_LENGTH ||
    /<[^>]*>/.test(value)
  ) {
    throw new Error("Skill description must be non-empty, max 1024 chars, and cannot contain XML tags");
  }
}

function parseSimpleYamlFrontmatter(frontmatter: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match?.[1]) {
      continue;
    }
    result[match[1]] = stripYamlScalarQuotes(match[2] ?? "").trim();
  }
  return result;
}

function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
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

function assertSafeGitHubSegment(value: string, name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`GitHub ${name} contains unsupported characters`);
  }
}

function skillsBucketName(): string {
  return requireEnv("SKILLS_BUCKET_NAME");
}
