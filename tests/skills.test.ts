/**
 * Skill validation tests.
 * Cover frontmatter parsing, path safety, and GitHub import URL sanitization.
 */

import { describe, expect, it } from "bun:test";
import {
  formatSkillPath,
  parseGitHubSkillUrl,
  parseSkillMarkdown,
  parseSkillPath,
  skillInstructionsFromMarkdown,
} from "../functions/_shared/skills.ts";

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
