/**
 * Harness-processing skill loading and invocation tests.
 * Cover listConfiguredSkillMetadata, loadConfiguredSkillPrompt, listSkillMetadataForConfig, and loadSkillContent.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { S3ObjectInfo } from "../functions/_shared/s3.ts";

const ORIGINAL_ENV = { ...process.env };
const s3Writes: Array<{ bucket: string; key: string; body: string | Uint8Array; options?: Record<string, unknown> }> = [];
const s3Copies: Array<{
  sourceBucket: string;
  sourceKey: string;
  destinationBucket: string;
  destinationKey: string;
  options?: Record<string, unknown>;
}> = [];
const s3Deletes: Array<{ bucket: string; key: string }> = [];

const s3ObjectExistsMock = mock(async (_bucket: string, _key: string) => false);
const readS3TextMock = mock(async (_bucket: string, _key: string): Promise<string> => {
  throw new Error("NoSuchKey");
});
const readS3BytesMock = mock(async (_bucket: string, _key: string): Promise<Uint8Array> => new Uint8Array());
const listS3PrefixMock = mock(async (_bucket: string, _prefix: string): Promise<S3ObjectInfo[]> => []);
const writeS3ObjectMock = mock(async (
  bucket: string,
  key: string,
  body: string | Uint8Array,
  options?: Record<string, unknown>,
) => {
  s3Writes.push({ bucket, key, body, options });
  return typeof body === "string" ? body.length : body.byteLength;
}
);
const ensureS3DirectoryMarkersMock = mock(async (_bucket: string, _key: string) => {});
const copyS3ObjectMock = mock(async (
  sourceBucket: string,
  sourceKey: string,
  destinationBucket: string,
  destinationKey: string,
  options?: Record<string, unknown>,
) => {
  s3Copies.push({ sourceBucket, sourceKey, destinationBucket, destinationKey, options });
});
const deleteS3ObjectMock = mock(async (bucket: string, key: string) => {
  s3Deletes.push({ bucket, key });
});

mock.module("../functions/_shared/s3.ts", () => ({
  s3ObjectExists: s3ObjectExistsMock,
  isMissingS3Error: (error: unknown) =>
    error instanceof Error && error.message === "NoSuchKey",
  readS3Text: readS3TextMock,
  readS3Bytes: readS3BytesMock,
  listS3Prefix: listS3PrefixMock,
  writeS3Object: writeS3ObjectMock,
  copyS3Object: copyS3ObjectMock,
  deleteS3Object: deleteS3ObjectMock,
  ensureS3DirectoryMarkers: ensureS3DirectoryMarkersMock,
}));

beforeEach(() => {
  process.env.SKILLS_BUCKET_NAME = "test-skills-bucket";
  delete process.env.FILESYSTEM_BUCKET_NAME;
  s3Writes.length = 0;
  s3Copies.length = 0;
  s3Deletes.length = 0;
  s3ObjectExistsMock.mockClear();
  readS3TextMock.mockClear();
  readS3BytesMock.mockClear();
  listS3PrefixMock.mockClear();
  writeS3ObjectMock.mockClear();
  copyS3ObjectMock.mockClear();
  deleteS3ObjectMock.mockClear();
  ensureS3DirectoryMarkersMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function createSkillMarkdown(name: string, description: string, content = "# Instructions\nUse this skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;
}

describe("listConfiguredSkillMetadata", () => {
  it("returns empty array when skills are not enabled", async () => {
    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    const result = await listConfiguredSkillMetadata("acct_test", {
      skills: { enabled: false },
    });

    expect(result).toEqual([]);
  });

  it("returns empty array when skills config is undefined", async () => {
    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    const result = await listConfiguredSkillMetadata("acct_test", {});

    expect(result).toEqual([]);
  });

  it("returns empty array when accountId is undefined", async () => {
    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    const result = await listConfiguredSkillMetadata(undefined, {
      skills: { enabled: true, allowed: ["acct_test/my-skill"] },
    });

    expect(result).toEqual([]);
  });

  it("returns empty array when allowed skills list is empty", async () => {
    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    const result = await listConfiguredSkillMetadata("acct_test", {
      skills: { enabled: true, allowed: [] },
    });

    expect(result).toEqual([]);
  });

  it("returns skill metadata for configured skills", async () => {
    const skillContent = createSkillMarkdown("my-skill", "A test skill");

    s3ObjectExistsMock.mockResolvedValue(true);
    readS3TextMock.mockResolvedValue(skillContent);

    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    const result = await listConfiguredSkillMetadata("acct_test", {
      skills: { enabled: true, allowed: ["acct_test/my-skill"] },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "my-skill",
      description: "A test skill",
      path: "acct_test/my-skill",
    });
  });

  it("skips skills that do not exist in S3", async () => {
    s3ObjectExistsMock.mockResolvedValue(true);
    readS3TextMock.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });

    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    const result = await listConfiguredSkillMetadata("acct_test", {
      skills: { enabled: true, allowed: ["acct_test/missing-skill"] },
    });

    expect(result).toEqual([]);
  });

  it("throws when skill path belongs to another account", async () => {
    s3ObjectExistsMock.mockResolvedValue(true);

    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    await expect(
      listConfiguredSkillMetadata("acct_test", {
        skills: { enabled: true, allowed: ["acct_other/my-skill"] },
      }),
    ).rejects.toThrow("Skill path belongs to another account: acct_other/my-skill");
  });

  it("throws when skill path is invalid", async () => {
    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    await expect(
      listConfiguredSkillMetadata("acct_test", {
        skills: { enabled: true, allowed: ["invalid-path"] },
      }),
    ).rejects.toThrow("Invalid skill path: invalid-path");
  });

  it("handles multiple skills with mixed existence", async () => {
    const skill1Content = createSkillMarkdown("skill-one", "First skill");

    s3ObjectExistsMock.mockResolvedValue(true);
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.includes("skill-one")) return skill1Content;
      throw new Error("NoSuchKey");
    });

    const { listConfiguredSkillMetadata } = await import("../functions/harness-processing/skills.ts");

    const result = await listConfiguredSkillMetadata("acct_test", {
      skills: { enabled: true, allowed: ["acct_test/skill-one", "acct_test/missing-skill"] },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("skill-one");
  });
});

describe("loadConfiguredSkillPrompt", () => {
  it("throws when skill path is not in allowed list", async () => {
    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    await expect(
      loadConfiguredSkillPrompt(["acct_test/allowed-skill"], "acct_test/other-skill"),
    ).rejects.toThrow("Skill is not configured for this agent: acct_test/other-skill");
  });

  it("loads skill prompt with default resource paths", async () => {
    const skillContent = createSkillMarkdown("test-skill", "Test description", "# Test Instructions\nDo something.");

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      throw new Error("NoSuchKey");
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(["acct_test/test-skill"], "acct_test/test-skill");

    expect(result.path).toBe("acct_test/test-skill");
    expect(result.loadedPaths).toEqual(["SKILL.md"]);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.prompt.role).toBe("system");
    expect(result.prompt.content).toContain('<loaded-skill path="acct_test/test-skill" name="test-skill">');
    expect(result.prompt.content).toContain("## SKILL.md");
    expect(result.prompt.content).toContain("# Test Instructions");
    expect(result.prompt.content).toContain("</loaded-skill>");
  });

  it("loads skill prompt with additional resource files", async () => {
    const skillContent = createSkillMarkdown("resource-skill", "Resource skill");
    const readmeContent = "# README\nThis is a readme.";
    const configContent = '{"key": "value"}';

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      if (key.endsWith("README.md")) return readmeContent;
      if (key.endsWith("config.json")) return configContent;
      throw new Error("NoSuchKey");
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(
      ["acct_test/resource-skill"],
      "acct_test/resource-skill",
      ["README.md", "config.json"],
    );

    expect(result.loadedPaths).toContain("SKILL.md");
    expect(result.loadedPaths).toContain("README.md");
    expect(result.loadedPaths).toContain("config.json");
    expect(result.prompt.content).toContain("## README.md");
    expect(result.prompt.content).toContain("## config.json");
    expect(result.prompt.content).toContain("# README");
    expect(result.prompt.content).toContain('{"key": "value"}');
  });

  it("filters SKILL.md from resource paths to avoid duplication", async () => {
    const skillContent = createSkillMarkdown("dedup-skill", "Dedup skill");

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      throw new Error("NoSuchKey");
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(
      ["acct_test/dedup-skill"],
      "acct_test/dedup-skill",
      ["SKILL.md"],
    );

    const skillMdCount = (result.prompt.content as string).match(/## SKILL\.md/g)?.length ?? 0;
    expect(skillMdCount).toBe(1);
  });

  it("calculates correct byte size for loaded content", async () => {
    const skillContent = createSkillMarkdown("byte-skill", "Byte skill", "# Content");

    readS3TextMock.mockResolvedValue(skillContent);

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(["acct_test/byte-skill"], "acct_test/byte-skill");

    const instructions = "# Content";
    const expectedBytes = Buffer.byteLength(instructions, "utf-8");
    expect(result.bytes).toBe(expectedBytes);
  });

  it("stages the skill bundle into the workspace namespace for sandbox execution", async () => {
    const skillContent = createSkillMarkdown(
      "script-skill",
      "Script skill",
      "Use scripts/analyze.py for analysis.",
    );
    const scriptBytes = new TextEncoder().encode("print('ok')\n");

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      if (key.endsWith("scripts/analyze.py")) return "print('ok')\n";
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (_bucket: string, prefix: string) => {
      if (prefix === "acct_test/script-skill/") {
        return [
          { key: "acct_test/script-skill/SKILL.md", size: skillContent.length, etag: "skill-etag" },
          { key: "acct_test/script-skill/scripts/analyze.py", size: scriptBytes.byteLength, etag: "script-etag" },
        ];
      }
      if (prefix === "fs-0123456789abcdef0123456789abcdef01234567/.claude/skills/script-skill/") {
        return [];
      }
      return [];
    });
    readS3BytesMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("scripts/analyze.py")) return scriptBytes;
      return new TextEncoder().encode(skillContent);
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(
      ["acct_test/script-skill"],
      "acct_test/script-skill",
      ["scripts/analyze.py"],
      "fs-0123456789abcdef0123456789abcdef01234567",
    );

    expect(result.stagedPath).toBe("/.claude/skills/script-skill");
    expect(result.stagedFiles).toEqual(["SKILL.md", "scripts/analyze.py"]);
    expect(result.prompt.content).toContain("staged inside the current sandbox at `/.claude/skills/script-skill`");
    expect(s3Copies).toContainEqual({
      sourceBucket: "test-skills-bucket",
      sourceKey: "acct_test/script-skill/scripts/analyze.py",
      destinationBucket: "workspace-bucket",
      destinationKey: "fs-0123456789abcdef0123456789abcdef01234567/.claude/skills/script-skill/scripts/analyze.py",
      options: { contentType: "text/plain; charset=utf-8", executable: true },
    });
    // Mirrored into the .agents/skills location for tools that expect it.
    expect(result.prompt.content).toContain("/.agents/skills/script-skill");
    expect(s3Copies).toContainEqual({
      sourceBucket: "test-skills-bucket",
      sourceKey: "acct_test/script-skill/scripts/analyze.py",
      destinationBucket: "workspace-bucket",
      destinationKey: "fs-0123456789abcdef0123456789abcdef01234567/.agents/skills/script-skill/scripts/analyze.py",
      options: { contentType: "text/plain; charset=utf-8", executable: true },
    });
    // Staging no longer writes a manifest — every load re-stages from source.
    expect(s3Writes.filter((write) => write.key.endsWith(".stage.json"))).toHaveLength(0);
  });

  it("re-stages from source on every load, replacing stale staged files", async () => {
    const skillContent = createSkillMarkdown("refresh-skill", "Refresh skill");
    const canonicalPrefix =
      "fs-0123456789abcdef0123456789abcdef01234567/.claude/skills/refresh-skill/";

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (_bucket: string, prefix: string) => {
      if (prefix === "acct_test/refresh-skill/") {
        return [{ key: "acct_test/refresh-skill/SKILL.md", size: skillContent.length, etag: "skill-etag" }];
      }
      if (prefix === canonicalPrefix) {
        // A stale file from a prior load that is no longer in the source bundle.
        return [{ key: `${prefix}old.py`, size: 10, etag: "stale-etag" }];
      }
      return [];
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(
      ["acct_test/refresh-skill"],
      "acct_test/refresh-skill",
      [],
      "fs-0123456789abcdef0123456789abcdef01234567",
    );

    expect(result.stagedFiles).toEqual(["SKILL.md"]);
    // Source is always re-copied; no manifest is written or read.
    expect(s3Copies).toContainEqual({
      sourceBucket: "test-skills-bucket",
      sourceKey: "acct_test/refresh-skill/SKILL.md",
      destinationBucket: "workspace-bucket",
      destinationKey: `${canonicalPrefix}SKILL.md`,
      options: { contentType: "text/plain; charset=utf-8", executable: false },
    });
    expect(s3Writes.filter((write) => write.key.endsWith(".stage.json"))).toHaveLength(0);
    // The stale file no longer in source is removed.
    expect(s3Deletes).toContainEqual({ bucket: "workspace-bucket", key: `${canonicalPrefix}old.py` });
  });

  it("throws when skill path is invalid", async () => {
    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    await expect(
      loadConfiguredSkillPrompt(["invalid"], "invalid"),
    ).rejects.toThrow("Invalid skill path: invalid");
  });

  it("throws when skill file does not exist in S3", async () => {
    readS3TextMock.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    await expect(
      loadConfiguredSkillPrompt(["acct_test/missing-skill"], "acct_test/missing-skill"),
    ).rejects.toThrow();
  });
});

describe("listSkillMetadataForConfig", () => {
  it("returns empty array when no skill paths provided", async () => {
    const { listSkillMetadataForConfig } = await import("../functions/harness-processing/skills.ts");

    const result = await listSkillMetadataForConfig("acct_test", []);

    expect(result).toEqual([]);
  });

  it("returns metadata for existing skills", async () => {
    const skillContent = createSkillMarkdown("existing-skill", "An existing skill", "# Instructions\nFollow these steps.");

    s3ObjectExistsMock.mockResolvedValue(true);
    readS3TextMock.mockResolvedValue(skillContent);

    const { listSkillMetadataForConfig } = await import("../functions/harness-processing/skills.ts");

    const result = await listSkillMetadataForConfig("acct_test", ["acct_test/existing-skill"]);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "existing-skill",
      description: "An existing skill",
      path: "acct_test/existing-skill",
    });
  });

  it("skips skills that cannot be read from S3", async () => {
    s3ObjectExistsMock.mockResolvedValue(true);
    readS3TextMock.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });

    const { listSkillMetadataForConfig } = await import("../functions/harness-processing/skills.ts");

    const result = await listSkillMetadataForConfig("acct_test", ["acct_test/missing-skill"]);

    expect(result).toEqual([]);
  });

  it("throws when skill path belongs to another account", async () => {
    s3ObjectExistsMock.mockResolvedValue(true);

    const { listSkillMetadataForConfig } = await import("../functions/harness-processing/skills.ts");

    await expect(
      listSkillMetadataForConfig("acct_test", ["acct_other/foreign-skill"]),
    ).rejects.toThrow("Skill path belongs to another account: acct_other/foreign-skill");
  });

  it("throws when skill path is invalid format", async () => {
    const { listSkillMetadataForConfig } = await import("../functions/harness-processing/skills.ts");

    await expect(
      listSkillMetadataForConfig("acct_test", ["no-slash"]),
    ).rejects.toThrow("Invalid skill path: no-slash");
  });

  it("handles multiple skills correctly", async () => {
    const skill1Content = createSkillMarkdown("alpha-skill", "Alpha skill");
    const skill2Content = createSkillMarkdown("beta-skill", "Beta skill");

    s3ObjectExistsMock.mockResolvedValue(true);
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.includes("alpha")) return skill1Content;
      if (key.includes("beta")) return skill2Content;
      throw new Error("NoSuchKey");
    });

    const { listSkillMetadataForConfig } = await import("../functions/harness-processing/skills.ts");

    const result = await listSkillMetadataForConfig("acct_test", [
      "acct_test/alpha-skill",
      "acct_test/beta-skill",
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("alpha-skill");
    expect(result[1]?.name).toBe("beta-skill");
  });

  it("throws when skill does not exist in S3", async () => {
    s3ObjectExistsMock.mockResolvedValue(false);

    const { listSkillMetadataForConfig } = await import("../functions/harness-processing/skills.ts");

    await expect(
      listSkillMetadataForConfig("acct_test", ["acct_test/nonexistent-skill"]),
    ).rejects.toThrow("Skill not found: acct_test/nonexistent-skill");
  });
});

describe("loadSkillContent", () => {
  it("loads skill content with metadata", async () => {
    const skillContent = createSkillMarkdown("load-skill", "Loadable skill", "# Main Instructions\nDo the thing.");

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      throw new Error("NoSuchKey");
    });

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    const result = await loadSkillContent("acct_test/load-skill");

    expect(result.path).toBe("acct_test/load-skill");
    expect(result.skill).toEqual({
      name: "load-skill",
      description: "Loadable skill",
      path: "acct_test/load-skill",
    });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.path).toBe("SKILL.md");
    expect(result.parts[0]?.text).toBe("# Main Instructions\nDo the thing.");
    expect(result.bytes).toBeGreaterThan(0);
  });

  it("loads skill content with resource files", async () => {
    const skillContent = createSkillMarkdown("resourceful-skill", "Resourceful skill");
    const helperContent = "function helper() { return true; }";

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      if (key.endsWith("helper.js")) return helperContent;
      throw new Error("NoSuchKey");
    });

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    const result = await loadSkillContent("acct_test/resourceful-skill", ["helper.js"]);

    expect(result.parts).toHaveLength(2);
    expect(result.parts[0]?.path).toBe("SKILL.md");
    expect(result.parts[1]?.path).toBe("helper.js");
    expect(result.parts[1]?.text).toBe(helperContent);
  });

  it("throws when skill path is invalid", async () => {
    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    await expect(loadSkillContent("not/a/valid/path")).rejects.toThrow(
      "Invalid skill path: not/a/valid/path",
    );
  });

  it("throws when skill path has too many segments", async () => {
    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    await expect(loadSkillContent("acct/skill/extra")).rejects.toThrow(
      "Invalid skill path: acct/skill/extra",
    );
  });

  it("throws when skill name is invalid", async () => {
    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    await expect(loadSkillContent("acct/Invalid-Name")).rejects.toThrow(
      "Invalid skill path: acct/Invalid-Name",
    );
  });

  it("throws when skill file does not exist", async () => {
    readS3TextMock.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    await expect(loadSkillContent("acct_test/missing-skill")).rejects.toThrow();
  });

  it("throws when skill markdown is malformed", async () => {
    readS3TextMock.mockResolvedValue("This is not valid skill markdown");

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    await expect(loadSkillContent("acct_test/bad-skill")).rejects.toThrow(
      "SKILL.md must start with YAML frontmatter",
    );
  });

  it("normalizes resource paths and rejects traversal", async () => {
    const skillContent = createSkillMarkdown("safe-skill", "Safe skill");

    readS3TextMock.mockResolvedValue(skillContent);

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    await expect(
      loadSkillContent("acct_test/safe-skill", ["../etc/passwd"]),
    ).rejects.toThrow("Invalid skill file path: ../etc/passwd");
  });

  it("calculates byte size across all parts", async () => {
    const skillContent = createSkillMarkdown("size-skill", "Size skill", "# Content");
    const extraContent = "extra data";

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      if (key.endsWith("extra.txt")) return extraContent;
      throw new Error("NoSuchKey");
    });

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    const result = await loadSkillContent("acct_test/size-skill", ["extra.txt"]);

    const skillInstructions = "# Content";
    const expectedBytes = Buffer.byteLength(skillInstructions, "utf-8") + Buffer.byteLength(extraContent, "utf-8");
    expect(result.bytes).toBe(expectedBytes);
  });

  it("handles empty resource paths array", async () => {
    const skillContent = createSkillMarkdown("empty-resources", "Empty resources skill", "# Instructions");

    readS3TextMock.mockResolvedValue(skillContent);

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    const result = await loadSkillContent("acct_test/empty-resources", []);

    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.path).toBe("SKILL.md");
  });

  it("handles undefined resource paths", async () => {
    const skillContent = createSkillMarkdown("undefined-resources", "Undefined resources skill", "# Instructions");

    readS3TextMock.mockResolvedValue(skillContent);

    const { loadSkillContent } = await import("../functions/harness-processing/skills.ts");

    const result = await loadSkillContent("acct_test/undefined-resources");

    expect(result.parts).toHaveLength(1);
  });
});

describe("SkillMetadata re-export", () => {
  it("exports skill-related functions", async () => {
    const skills = await import("../functions/harness-processing/skills.ts");

    expect(typeof skills.listConfiguredSkillMetadata).toBe("function");
    expect(typeof skills.loadConfiguredSkillPrompt).toBe("function");
  });
});

describe("formatLoadedSkillPrompt output structure", () => {
  it("wraps content in loaded-skill XML tags with path and name attributes", async () => {
    const skillContent = createSkillMarkdown("xml-skill", "XML skill", "# XML Test");

    readS3TextMock.mockResolvedValue(skillContent);

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(["acct_test/xml-skill"], "acct_test/xml-skill");
    const promptContent = result.prompt.content as string;

    expect(promptContent).toMatch(/^<loaded-skill path="acct_test\/xml-skill" name="xml-skill">/);
    expect(promptContent).toMatch(/<\/loaded-skill>$/);
  });

  it("formats each part with markdown heading using file path", async () => {
    const skillContent = createSkillMarkdown("heading-skill", "Heading skill", "# Heading Content");
    const readmeContent = "# README Content";

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      if (key.endsWith("README.md")) return readmeContent;
      throw new Error("NoSuchKey");
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(
      ["acct_test/heading-skill"],
      "acct_test/heading-skill",
      ["README.md"],
    );
    const promptContent = result.prompt.content as string;

    expect(promptContent).toContain("## SKILL.md");
    expect(promptContent).toContain("## README.md");
  });

  it("trims whitespace from each part text", async () => {
    const skillContent = createSkillMarkdown("trim-skill", "Trim skill", "  # Whitespace Content  \n");

    readS3TextMock.mockResolvedValue(skillContent);

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(["acct_test/trim-skill"], "acct_test/trim-skill");
    const promptContent = result.prompt.content as string;

    expect(promptContent).not.toContain("  # Whitespace Content  ");
    expect(promptContent).toContain("# Whitespace Content");
  });
});
