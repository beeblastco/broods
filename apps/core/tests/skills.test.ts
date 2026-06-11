/**
 * Skill validation tests.
 * Cover frontmatter parsing, path safety, and GitHub import URL sanitization.
 */

import { describe, expect, it } from "bun:test";
import {
  contentTypeForSkillPath,
  formatSkillPath,
  isExecutableSkillPath,
  parseGitHubSkillUrl,
  parseSkillMarkdown,
  parseSkillPath,
  skillInstructionsFromMarkdown,
  validateSkillBundle,
  type SkillBundleFile,
} from "../functions/_shared/skills.ts";

function bundleFile(path: string, content: string | Uint8Array): SkillBundleFile {
  return { path, bytes: typeof content === "string" ? new TextEncoder().encode(content) : content };
}

function skillMarkdown(name: string, description = "A test skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

describe("skill validation", () => {
  it("parses required SKILL.md frontmatter and separates instructions", () => {
    const markdown = `---
name: pdf-processing
description: Extracts PDF text. Use when working with PDFs.
---

# PDF Processing

Use the approved parser.`;

    expect(parseSkillMarkdown(markdown)).toEqual({
      name: "pdf-processing",
      description: "Extracts PDF text. Use when working with PDFs.",
    });
    expect(skillInstructionsFromMarkdown(markdown)).toBe("# PDF Processing\n\nUse the approved parser.");
  });

  it("rejects invalid skill metadata", () => {
    expect(() => parseSkillMarkdown("missing")).toThrow("SKILL.md must start with YAML frontmatter");
    expect(() => parseSkillMarkdown(`---
name: Claude-helper
description: ok
---`)).toThrow("Skill name must be lowercase");
    expect(() => parseSkillMarkdown(`---
name: safe-name
description: <tag>bad</tag>
---`)).toThrow("Skill description must be non-empty");
  });

  it("formats and parses account-scoped skill paths", () => {
    expect(formatSkillPath("acct_123", "support-flow")).toBe("acct_123/support-flow");
    expect(parseSkillPath("acct_123/support-flow")).toEqual({
      accountId: "acct_123",
      skillName: "support-flow",
    });
    expect(parseSkillPath("acct_123/../support-flow")).toBeNull();
  });

  it("sanitizes GitHub skill tree URLs", () => {
    expect(parseGitHubSkillUrl("https://github.com/anthropics/skills/tree/main/skills/pdf")).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      subdir: "skills/pdf",
      archiveUrl: "https://codeload.github.com/anthropics/skills/tar.gz/main",
    });

    expect(() => parseGitHubSkillUrl("http://github.com/anthropics/skills/tree/main/pdf")).toThrow(
      "GitHub skill URL must use https://github.com",
    );
    expect(() => parseGitHubSkillUrl("https://github.com/anthropics/skills/blob/main/pdf")).toThrow(
      "GitHub skill URL must be https://github.com/{owner}/{repo}/tree/{ref}/{path}",
    );
    expect(() => parseGitHubSkillUrl("https://github.com/anthropics/skills/tree/main/../secret")).toThrow(
      "Invalid skill file path",
    );
  });
});

describe("validateSkillBundle", () => {
  it("returns parsed metadata and normalized files without mutating the input", () => {
    const input = [
      bundleFile("  SKILL.md  ", skillMarkdown("bundle-skill", "Bundle metadata.")),
      bundleFile("scripts/run.sh", "echo hi\n"),
    ];

    const { metadata, files } = validateSkillBundle(input);

    expect(metadata).toEqual({ name: "bundle-skill", description: "Bundle metadata." });
    expect(files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/run.sh"]);
    // The caller's objects are left untouched; normalization happens on a copy.
    expect(input[0]?.path).toBe("  SKILL.md  ");
  });

  it("throws when the bundle has no SKILL.md at the root", () => {
    expect(() => validateSkillBundle([bundleFile("docs/SKILL.md", skillMarkdown("nested"))]))
      .toThrow("Skill bundle must include SKILL.md at the root");
  });

  it("throws on duplicate normalized paths", () => {
    expect(() => validateSkillBundle([
      bundleFile("SKILL.md", skillMarkdown("dup")),
      bundleFile("  SKILL.md", skillMarkdown("dup")),
    ])).toThrow("Duplicate skill file path: SKILL.md");
  });

  it("throws on unsupported or binary files", () => {
    const skill = bundleFile("SKILL.md", skillMarkdown("binary"));
    expect(() => validateSkillBundle([skill, bundleFile("data.bin", "x")]))
      .toThrow("Skill file must be a supported text file: data.bin");
    expect(() => validateSkillBundle([skill, bundleFile("notes.txt", new Uint8Array([0x41, 0x00, 0x42]))]))
      .toThrow("Skill file must be a supported text file: notes.txt");
  });

  it("throws when a single file exceeds the per-file limit", () => {
    expect(() => validateSkillBundle([bundleFile("SKILL.md", "x".repeat(5 * 1024 * 1024 + 1))]))
      .toThrow("Skill file is too large: SKILL.md");
  });
});

describe("isExecutableSkillPath", () => {
  it("marks script files as executable", () => {
    for (const path of ["scripts/run.sh", "a.bash", "b.zsh", "tool.py", "x.js", "y.mjs", "z.ts"]) {
      expect(isExecutableSkillPath(path)).toBe(true);
    }
  });

  it("does not mark documents or data files as executable", () => {
    for (const path of ["SKILL.md", "config.json", "notes.txt", "data.yaml", "Makefile"]) {
      expect(isExecutableSkillPath(path)).toBe(false);
    }
  });
});

describe("contentTypeForSkillPath", () => {
  it("returns application/json for JSON files and text/plain otherwise", () => {
    expect(contentTypeForSkillPath("config.json")).toBe("application/json");
    expect(contentTypeForSkillPath("SKILL.md")).toBe("text/plain; charset=utf-8");
    expect(contentTypeForSkillPath("scripts/run.sh")).toBe("text/plain; charset=utf-8");
  });
});
