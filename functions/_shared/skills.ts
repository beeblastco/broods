/**
 * Shared skill storage primitives and validation rules.
 * Keep endpoint CRUD in account-manage and prompt loading in harness-processing.
 */

import { readS3Text, s3ObjectExists } from "./s3.ts";
import { requireEnv } from "./env.ts";

export const SKILL_FILE = "SKILL.md";
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

export interface SkillMetadata {
  name: string;
  description: string;
  skillPath: string;
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
