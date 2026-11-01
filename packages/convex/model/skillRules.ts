// Core imports this too and mirrors its rules in src/shared/skills.ts: no runtime imports.

import { ClientError } from "./clientError";

export const SKILL_FILE = "SKILL.md";
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
// Core reads only this head of each SKILL.md for the per-turn skill list.
export const MAX_SKILL_METADATA_BYTES = 64 * 1024;

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
    throw new ClientError(
      "Skill name must be lowercase letters, numbers, and hyphens only, max 64 chars, without reserved words",
    );
  }
}

export function validateSkillDescription(
  value: unknown,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_SKILL_DESCRIPTION_LENGTH ||
    /<[^>]*>/.test(value)
  ) {
    throw new ClientError(
      "Skill description must be non-empty, max 1024 chars, and cannot contain XML tags",
    );
  }
}

export function normalizeBundlePath(value: string): string {
  if (typeof value !== "string") {
    throw new ClientError("Skill file path must be a string");
  }

  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new ClientError(`Invalid skill file path: ${value}`);
  }

  return trimmed;
}

export function parseSkillMarkdown(markdown: string): {
  name: string;
  description: string;
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    throw new ClientError("SKILL.md must start with YAML frontmatter");
  }

  const frontmatter = parseSimpleYamlFrontmatter(match[1]);
  const name = frontmatter.name;
  const description = frontmatter.description;
  validateSkillName(name);
  validateSkillDescription(description);

  return { name: name, description: description };
}

export function contentTypeForSkillPath(filePath: string): string {
  return filePath.toLowerCase().endsWith(".json")
    ? "application/json"
    : "text/plain; charset=utf-8";
}

export function parseGitHubSkillUrl(value: unknown): {
  owner: string;
  repo: string;
  ref: string;
  subdir: string;
  archiveUrl: string;
} {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClientError("url must be a non-empty string");
  }

  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw new ClientError("GitHub skill URL must use https://github.com");
  }
  if (/%2e/i.test(value.trim()) || value.trim().includes("..")) {
    throw new ClientError(
      "Invalid skill file path: GitHub URL must not contain path traversal",
    );
  }

  const [owner, repo, kind, ref, ...subdirParts] = url.pathname
    .split("/")
    .filter(Boolean);
  if (!owner || !repo || kind !== "tree" || !ref) {
    throw new ClientError(
      "GitHub skill URL must be https://github.com/{owner}/{repo}/tree/{ref}/{path}",
    );
  }
  assertSafeGitHubSegment(owner, "owner");
  assertSafeGitHubSegment(repo, "repo");
  assertSafeGitHubSegment(ref, "ref");
  const subdir = subdirParts.map((part) => normalizeBundlePath(part)).join("/");

  return {
    owner: owner,
    repo: repo,
    ref: ref,
    subdir: subdir,
    archiveUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
  };
}

function parseSimpleYamlFrontmatter(
  frontmatter: string,
): Record<string, string> {
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
    throw new ClientError(`GitHub ${name} contains unsupported characters`);
  }
}
