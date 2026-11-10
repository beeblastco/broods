import { describe, expect, it } from "bun:test";
import {
  parseSkillMarkdown,
  parseSkillPath,
  skillInstructionsFromMarkdown,
} from "../src/shared/skills.ts";

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
    expect(skillInstructionsFromMarkdown(markdown)).toBe(
      "# PDF Processing\n\nUse the approved parser.",
    );
  });

  it("rejects invalid skill metadata", () => {
    expect(() => parseSkillMarkdown("missing")).toThrow(
      "SKILL.md must start with YAML frontmatter",
    );
    expect(() =>
      parseSkillMarkdown(`---
name: Claude-helper
description: ok
---`),
    ).toThrow("Skill name must be lowercase");
    expect(() =>
      parseSkillMarkdown(`---
name: safe-name
description: <tag>bad</tag>
---`),
    ).toThrow("Skill description must be non-empty");
  });

  it("parses account-scoped skill paths", () => {
    expect(parseSkillPath("acct_123/support-flow")).toEqual({
      accountId: "acct_123",
      skillName: "support-flow",
    });
    expect(parseSkillPath("acct_123/../support-flow")).toBeNull();
  });

  it("parses frontmatter longer than the head an upload validates", () => {
    const lateFrontmatter = `---\nname: late-skill\ndescription: Late\nnotes: ${"y".repeat(64 * 1024)}\n---\n`;
    expect(parseSkillMarkdown(lateFrontmatter).name).toBe("late-skill");
  });
});
