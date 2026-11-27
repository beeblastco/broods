import { describe, expect, it } from "vitest";
import { parseGitHubSkillUrl, parseSkillMarkdown } from "../model/skillRules";
import { validateSkillBundle, type SkillBundleFile } from "../model/skills";

function bundleFile(
  path: string,
  content: string | Uint8Array,
): SkillBundleFile {
  return {
    path: path,
    bytes:
      typeof content === "string" ? new TextEncoder().encode(content) : content,
  };
}

function skillMarkdown(name: string, description = "A test skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

describe("parseGitHubSkillUrl", (): void => {
  it("sanitizes GitHub skill tree URLs", (): void => {
    expect(
      parseGitHubSkillUrl(
        "https://github.com/anthropics/skills/tree/main/skills/pdf",
      ),
    ).toEqual({
      owner: "anthropics",
      repo: "skills",
      ref: "main",
      subdir: "skills/pdf",
      archiveUrl: "https://codeload.github.com/anthropics/skills/tar.gz/main",
    });

    expect(() =>
      parseGitHubSkillUrl("http://github.com/anthropics/skills/tree/main/pdf"),
    ).toThrow("GitHub skill URL must use https://github.com");
    expect(() =>
      parseGitHubSkillUrl("https://github.com/anthropics/skills/blob/main/pdf"),
    ).toThrow(
      "GitHub skill URL must be https://github.com/{owner}/{repo}/tree/{ref}/{path}",
    );
    expect(() =>
      parseGitHubSkillUrl(
        "https://github.com/anthropics/skills/tree/main/../secret",
      ),
    ).toThrow("Invalid skill file path");
  });
});

describe("validateSkillBundle", (): void => {
  it("returns parsed metadata and normalized files without mutating the input", (): void => {
    const input = [
      bundleFile(
        "  SKILL.md  ",
        skillMarkdown("bundle-skill", "Bundle metadata."),
      ),
      bundleFile("scripts/run.sh", "echo hi\n"),
    ];

    const { metadata, files } = validateSkillBundle(input);

    expect(metadata).toEqual({
      name: "bundle-skill",
      description: "Bundle metadata.",
    });
    expect(files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/run.sh",
    ]);
    expect(input[0]?.path).toBe("  SKILL.md  ");
  });

  it("throws when the bundle has no SKILL.md at the root", (): void => {
    expect(() =>
      validateSkillBundle([
        bundleFile("docs/SKILL.md", skillMarkdown("nested")),
      ]),
    ).toThrow("Skill bundle must include SKILL.md at the root");
  });

  it("throws on duplicate normalized paths", (): void => {
    expect(() =>
      validateSkillBundle([
        bundleFile("SKILL.md", skillMarkdown("dup")),
        bundleFile("  SKILL.md", skillMarkdown("dup")),
      ]),
    ).toThrow("Duplicate skill file path: SKILL.md");
  });

  it("throws on unsupported or binary files", (): void => {
    const skill = bundleFile("SKILL.md", skillMarkdown("binary"));
    expect(() =>
      validateSkillBundle([skill, bundleFile("data.bin", "x")]),
    ).toThrow("Skill file must be a supported text file: data.bin");
    expect(() =>
      validateSkillBundle([
        skill,
        bundleFile("notes.txt", new Uint8Array([0x41, 0x00, 0x42])),
      ]),
    ).toThrow("Skill file must be a supported text file: notes.txt");
  });

  it("throws when a single file exceeds the per-file limit", (): void => {
    expect(() =>
      validateSkillBundle([
        bundleFile("SKILL.md", "x".repeat(5 * 1024 * 1024 + 1)),
      ]),
    ).toThrow("Skill file is too large: SKILL.md");
  });

  it("takes metadata only from the SKILL.md head the skill list reads", (): void => {
    const large = skillMarkdown("large-skill") + "x".repeat(4 * 1024 * 1024);
    expect(
      validateSkillBundle([bundleFile("SKILL.md", large)]).metadata.name,
    ).toBe("large-skill");
    const lateFrontmatter = `---\nname: late-skill\ndescription: Late\nnotes: ${"y".repeat(64 * 1024)}\n---\n`;
    expect(parseSkillMarkdown(lateFrontmatter).name).toBe("late-skill");
    expect(() =>
      validateSkillBundle([bundleFile("SKILL.md", lateFrontmatter)]),
    ).toThrow("SKILL.md must start with YAML frontmatter");
  });
});
