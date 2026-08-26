/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { createJsonSkillFiles, validateSkillBundle } from "./model/skills";
import { parseSkillMarkdown } from "./model/skillRules";

describe("UI-created skills satisfy the bundle validation (ticket 17)", () => {
  test("the New-skill editor output round-trips through validation", () => {
    // Exactly what the Skills tab's create form submits.
    const files = createJsonSkillFiles(
      "reply-in-haiku",
      "Answer every question as a haiku.",
      "When replying, always respond with a single haiku (5-7-5).",
    );
    const { metadata } = validateSkillBundle(files);
    expect(metadata.name).toBe("reply-in-haiku");
    expect(metadata.description).toBe("Answer every question as a haiku.");

    const markdown = new TextDecoder().decode(files[0]!.bytes);
    const parsed = parseSkillMarkdown(markdown);
    expect(parsed.name).toBe("reply-in-haiku");
  });

  test("invalid names are rejected before anything is stored", () => {
    expect(() =>
      createJsonSkillFiles("Bad Name!", "desc", "content"),
    ).toThrow();
    expect(() => createJsonSkillFiles("", "desc", "content")).toThrow();
  });

  test("a rename-style frontmatter rewrite still parses to the new name", () => {
    // The renameSkill action rewrites `name:` in the frontmatter; prove the
    // regex it uses produces a bundle that validates under the new name.
    const files = createJsonSkillFiles("old-name", "desc", "body");
    const markdown = new TextDecoder()
      .decode(files[0]!.bytes)
      .replace(/^name:\s*.*$/m, "name: new-name");
    const { metadata } = validateSkillBundle([
      { path: "SKILL.md", bytes: new TextEncoder().encode(markdown) },
    ]);
    expect(metadata.name).toBe("new-name");
  });
});
