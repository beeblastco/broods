/**
 * Shared skill storage primitives and validation rules.
 * Keep endpoint CRUD in account-manage and prompt loading in harness-processing.
 */

import { readS3Text, s3ObjectExists } from "./s3.ts";
import { requireEnv } from "./env.ts";
import path from "node:path";

export const SKILL_FILE = "SKILL.md";
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([
  ".css", ".csv", ".html", ".js", ".json", ".md", ".mjs", ".py", ".sh", ".sql", ".svg",
  ".toml", ".ts", ".tsx", ".txt", ".xml", ".yaml", ".yml",
]);
const EXECUTABLE_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".ts"]);

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

export interface SkillBundleFile {
  path: string;
  bytes: Uint8Array;
  contentType?: string;
}

export async function readSkillMarkdown(accountId: string, skillName: string): Promise<string | null> {
  validateSkillName(skillName);
  return readSkillText(formatSkillPath(accountId, skillName), SKILL_FILE).catch(() => null);
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

export async function readSkillText(skillPath: string, resourcePath: string): Promise<string> {
  return readS3Text(skillsBucketName(), `${skillPath}/${normalizeBundlePath(resourcePath)}`);
}

export function parseSkillMarkdown(markdown: string): Omit<SkillMetadata, "path"> {
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

export interface ValidatedSkillBundle {
  metadata: Omit<SkillMetadata, "path">;
  files: SkillBundleFile[];
}

export function validateSkillBundle(input: SkillBundleFile[]): ValidatedSkillBundle {
  const files = input.map((file) => ({ ...file, path: normalizeBundlePath(file.path) }));
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (seen.has(file.path)) {
      throw new Error(`Duplicate skill file path: ${file.path}`);
    }
    seen.add(file.path);
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
  return { metadata: parseSkillMarkdown(new TextDecoder().decode(skillFile.bytes)), files };
}

export function contentTypeForSkillPath(filePath: string): string {
  return path.extname(filePath).toLowerCase() === ".json"
    ? "application/json"
    : "text/plain; charset=utf-8";
}

export function isExecutableSkillPath(filePath: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

export function normalizeBundlePath(value: string): string {
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

export function validateSkillName(value: unknown): asserts value is string {
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

export function validateSkillDescription(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_SKILL_DESCRIPTION_LENGTH ||
    /<[^>]*>/.test(value)
  ) {
    throw new Error("Skill description must be non-empty, max 1024 chars, and cannot contain XML tags");
  }
}

function isSupportedTextFile(filePath: string, bytes: Uint8Array): boolean {
  if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return false;
  }
  return !bytes.includes(0);
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

function assertSafeGitHubSegment(value: string, name: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error(`GitHub ${name} contains unsupported characters`);
  }
}

export function skillsBucketName(): string {
  return requireEnv("SKILLS_BUCKET_NAME");
}
