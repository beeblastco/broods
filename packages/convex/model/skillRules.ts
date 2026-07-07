/**
 * Pure skill validation rules shared by the Convex config plane. Mirrors the
 * rule set in core's `src/shared/skills.ts` (no runtime or AWS dependencies,
 * safe for any Convex runtime). Keep S3-backed skill storage in model/skills.ts.
 */

export const SKILL_FILE = "SKILL.md";
const MAX_SKILL_NAME_LENGTH = 64;
const MAX_SKILL_DESCRIPTION_LENGTH = 1024;

/**
 * Assert a skill name is lowercase kebab-case without reserved words.
 * @param value candidate skill name
 * @throws when the name violates the naming rules
 */
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

/**
 * Assert a skill description is non-empty, bounded, and tag-free.
 * @param value candidate description
 * @throws when the description violates the rules
 */
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

/**
 * Normalize a bundle-relative file path, rejecting traversal and absolutes.
 * @param value candidate path
 * @returns the trimmed safe path
 * @throws when the path is unsafe
 */
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

/**
 * Parse SKILL.md YAML frontmatter into validated name and description.
 * @param markdown the SKILL.md contents
 * @returns the skill's name and description
 * @throws when frontmatter is missing or fields are invalid
 */
export function parseSkillMarkdown(markdown: string): { name: string; description: string } {
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

/**
 * Pick the stored content type for a skill file path.
 * @param filePath bundle-relative path
 * @returns the S3 content type
 */
export function contentTypeForSkillPath(filePath: string): string {
    return filePath.toLowerCase().endsWith(".json")
        ? "application/json"
        : "text/plain; charset=utf-8";
}

/**
 * Parse and validate a GitHub tree URL into its tarball download location.
 * @param value candidate URL
 * @returns owner, repo, ref, subdirectory, and codeload archive URL
 * @throws when the URL is not a safe github.com tree URL
 */
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
        owner: owner,
        repo: repo,
        ref: ref,
        subdir: subdir,
        archiveUrl: `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`,
    };
}

/**
 * Parse flat `key: value` YAML frontmatter lines.
 * @param frontmatter the frontmatter body
 * @returns the key/value map with scalar quotes stripped
 */
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

/**
 * Strip a single layer of matching quotes from a YAML scalar.
 * @param value the raw scalar
 * @returns the unquoted scalar
 */
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

/**
 * Reject GitHub path segments with characters outside the safe set.
 * @param value the segment
 * @param name which segment, for the error message
 * @throws when the segment has unsupported characters
 */
function assertSafeGitHubSegment(value: string, name: string): void {
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
        throw new Error(`GitHub ${name} contains unsupported characters`);
    }
}
