import { readS3Text } from "./s3.ts";
import { requireEnv } from "./env.ts";
import path from "node:path";
import {
  MAX_SKILL_BUNDLE_BYTES,
  MAX_SKILL_FILE_BYTES,
} from "@broods/convex/model/skillLimits";

export { MAX_SKILL_BUNDLE_BYTES, MAX_SKILL_FILE_BYTES };

export const SKILL_FILE = "SKILL.md";
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;
const EXECUTABLE_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".js",
  ".mjs",
  ".ts",
]);

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
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

export function contentTypeForSkillPath(filePath: string): string {
  return path.extname(filePath).toLowerCase() === ".json"
    ? "application/json"
    : "text/plain; charset=utf-8";
}

export function isExecutableSkillPath(filePath: string): boolean {
  return EXECUTABLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

export function parseSkillMarkdown(
  markdown: string,
): Omit<SkillMetadata, "path"> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match?.[1]) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }

  const frontmatter = parseSimpleYamlFrontmatter(match[1]);
  const name = frontmatter.name;
  const description = frontmatter.description;
  validateSkillName(name);
  validateSkillDescription(description);

  return { name: name, description: description };
}

// No S3 call: a caller that needs the skill to exist reads or HEADs it itself.
export function parseOwnedSkillPath(
  accountId: string,
  skillPath: string,
): NonNullable<ReturnType<typeof parseSkillPath>> {
  const parsed = parseSkillPath(skillPath);
  if (!parsed) {
    throw new Error(`Invalid skill path: ${skillPath}`);
  }
  if (parsed.accountId !== accountId) {
    throw new SkillAuthorizationError(skillPath);
  }

  return parsed;
}

export function parseSkillPath(
  skillPath: string,
): { accountId: string; skillName: string } | null {
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

export async function readSkillText(
  skillPath: string,
  resourcePath: string,
  maxBytes = MAX_SKILL_FILE_BYTES,
): Promise<string> {
  return readS3Text(
    skillsBucketName(),
    `${skillPath}/${normalizeBundlePath(resourcePath)}`,
    undefined,
    maxBytes,
  );
}

export function skillInstructionsFromMarkdown(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

export function skillsBucketName(): string {
  return requireEnv("SKILLS_BUCKET_NAME");
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
    throw new Error(
      "Skill description must be non-empty, max 1024 chars, and cannot contain XML tags",
    );
  }
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
    throw new Error(
      "Skill name must be lowercase letters, numbers, and hyphens only, max 64 chars, without reserved words",
    );
  }
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
