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
// Records the relative order of write/delete operations to assert publish never
// deletes the source bundle before the replacement has been written.
const s3Ops: Array<"write" | "delete"> = [];

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
  s3Ops.push("write");
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
  s3Ops.push("delete");
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
  s3Ops.length = 0;
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
      if (prefix === "fs-0123456789abcdef0123456789abcdef01234567/.skills/script-skill/") {
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

    expect(result.stagedPath).toBe("/.skills/script-skill");
    expect(result.stagedFiles).toEqual(["SKILL.md", "scripts/analyze.py"]);
    expect(result.prompt.content).toContain("workspace sandbox at `/.skills/script-skill`");
    expect(s3Copies).toContainEqual({
      sourceBucket: "test-skills-bucket",
      sourceKey: "acct_test/script-skill/scripts/analyze.py",
      destinationBucket: "workspace-bucket",
      destinationKey: "fs-0123456789abcdef0123456789abcdef01234567/.skills/script-skill/scripts/analyze.py",
      options: { contentType: "text/plain; charset=utf-8", executable: true },
    });
    expect(s3Writes.find((write) => write.key.endsWith(".stage.json"))).toBeDefined();
  });

  it("skips skill staging copies when the workspace manifest is current", async () => {
    const skillContent = createSkillMarkdown("cached-skill", "Cached skill");
    const manifest = {
      version: 1,
      skillPath: "acct_test/cached-skill",
      stagedAt: "2026-01-01T00:00:00.000Z",
      files: [
        {
          path: "SKILL.md",
          sourceKey: "acct_test/cached-skill/SKILL.md",
          etag: "skill-etag",
          size: skillContent.length,
        },
      ],
    };

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      if (key.endsWith(".stage.json")) return JSON.stringify(manifest);
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockResolvedValue([
      { key: "acct_test/cached-skill/SKILL.md", size: skillContent.length, etag: "skill-etag" },
    ]);

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    const result = await loadConfiguredSkillPrompt(
      ["acct_test/cached-skill"],
      "acct_test/cached-skill",
      [],
      "fs-0123456789abcdef0123456789abcdef01234567",
    );

    expect(result.stagedPath).toBe("/.skills/cached-skill");
    expect(result.stagedFiles).toEqual(["SKILL.md"]);
    expect(copyS3ObjectMock).not.toHaveBeenCalled();
    expect(writeS3ObjectMock).not.toHaveBeenCalled();
  });

  it("refreshes staged skill files when preserving staged edits is disabled", async () => {
    const skillContent = createSkillMarkdown("refresh-skill", "Refresh skill");
    const manifest = {
      version: 1,
      skillPath: "acct_test/refresh-skill",
      stagedAt: "2026-01-01T00:00:00.000Z",
      files: [
        {
          path: "SKILL.md",
          sourceKey: "acct_test/refresh-skill/SKILL.md",
          etag: "skill-etag",
          size: skillContent.length,
        },
      ],
    };

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return skillContent;
      if (key.endsWith(".stage.json")) return JSON.stringify(manifest);
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (_bucket: string, prefix: string) => {
      if (prefix === "acct_test/refresh-skill/") {
        return [{ key: "acct_test/refresh-skill/SKILL.md", size: skillContent.length, etag: "skill-etag" }];
      }
      if (prefix === "fs-0123456789abcdef0123456789abcdef01234567/.skills/refresh-skill/") {
        return [
          { key: `${prefix}.stage.json`, size: JSON.stringify(manifest).length },
          { key: `${prefix}SKILL.md`, size: skillContent.length, etag: "edited-etag" },
        ];
      }
      return [];
    });

    const { loadConfiguredSkillPrompt } = await import("../functions/harness-processing/skills.ts");

    await loadConfiguredSkillPrompt(
      ["acct_test/refresh-skill"],
      "acct_test/refresh-skill",
      [],
      "fs-0123456789abcdef0123456789abcdef01234567",
      { preserveStagedEdits: false },
    );

    expect(s3Copies).toContainEqual({
      sourceBucket: "test-skills-bucket",
      sourceKey: "acct_test/refresh-skill/SKILL.md",
      destinationBucket: "workspace-bucket",
      destinationKey: "fs-0123456789abcdef0123456789abcdef01234567/.skills/refresh-skill/SKILL.md",
      options: { contentType: "text/plain; charset=utf-8", executable: false },
    });
  });

  it("publishes validated staged skill edits back to the account skill bundle", async () => {
    const originalSkill = createSkillMarkdown("publish-skill", "Publish skill", "# Original");
    const editedSkill = createSkillMarkdown("publish-skill", "Publish skill", "# Edited");
    const oldBytes = new TextEncoder().encode("# old\n");
    const helperBytes = new TextEncoder().encode("echo edited\n");
    const manifest = {
      version: 1,
      skillPath: "acct_test/publish-skill",
      stagedAt: "2026-01-01T00:00:00.000Z",
      files: [
        {
          path: "SKILL.md",
          sourceKey: "acct_test/publish-skill/SKILL.md",
          etag: "source-skill-etag",
          size: originalSkill.length,
        },
        {
          path: "old.md",
          sourceKey: "acct_test/publish-skill/old.md",
          etag: "old-etag",
          size: oldBytes.byteLength,
        },
      ],
    };

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (bucket: string, key: string) => {
      if (bucket === "workspace-bucket" && key.endsWith(".stage.json")) return JSON.stringify(manifest);
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === "test-skills-bucket" && prefix === "acct_test/publish-skill/") {
        return [
          { key: "acct_test/publish-skill/SKILL.md", size: originalSkill.length, etag: "source-skill-etag" },
          { key: "acct_test/publish-skill/old.md", size: oldBytes.byteLength, etag: "old-etag" },
        ];
      }
      if (bucket === "workspace-bucket" && prefix === "fs-0123456789abcdef0123456789abcdef01234567/.skills/publish-skill/") {
        return [
          { key: `${prefix}.stage.json`, size: JSON.stringify(manifest).length },
          { key: `${prefix}SKILL.md`, size: editedSkill.length },
          { key: `${prefix}scripts/helper.sh`, size: helperBytes.byteLength },
        ];
      }
      return [];
    });
    readS3BytesMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return new TextEncoder().encode(editedSkill);
      if (key.endsWith("scripts/helper.sh")) return helperBytes;
      throw new Error("NoSuchKey");
    });

    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");

    const result = await publishStagedSkillBundle(
      ["acct_test/publish-skill"],
      "acct_test/publish-skill",
      "fs-0123456789abcdef0123456789abcdef01234567",
    );

    expect(result.files.map((file) => file.path)).toEqual(["SKILL.md", "scripts/helper.sh"]);
    // New bundle is written first; only source files dropped from the bundle (old.md) are deleted.
    expect(s3Writes).toContainEqual({
      bucket: "test-skills-bucket",
      key: "acct_test/publish-skill/SKILL.md",
      body: new TextEncoder().encode(editedSkill),
      options: { contentType: "text/plain; charset=utf-8" },
    });
    expect(s3Deletes).toEqual([{
      bucket: "test-skills-bucket",
      key: "acct_test/publish-skill/old.md",
    }]);
    expect(s3Deletes).not.toContainEqual({
      bucket: "test-skills-bucket",
      key: "acct_test/publish-skill/SKILL.md",
    });
  });

  it("writes the replacement bundle before deleting removed source files", async () => {
    const editedSkill = createSkillMarkdown("publish-skill", "Publish skill", "# Edited");
    const oldBytes = new TextEncoder().encode("# old\n");
    const manifest = {
      version: 1,
      skillPath: "acct_test/publish-skill",
      stagedAt: "2026-01-01T00:00:00.000Z",
      files: [
        { path: "SKILL.md", sourceKey: "acct_test/publish-skill/SKILL.md", etag: "skill-etag", size: editedSkill.length },
        { path: "old.md", sourceKey: "acct_test/publish-skill/old.md", etag: "old-etag", size: oldBytes.byteLength },
      ],
    };

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (bucket: string, key: string) => {
      if (bucket === "workspace-bucket" && key.endsWith(".stage.json")) return JSON.stringify(manifest);
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === "test-skills-bucket" && prefix === "acct_test/publish-skill/") {
        return [
          { key: "acct_test/publish-skill/SKILL.md", size: editedSkill.length, etag: "skill-etag" },
          { key: "acct_test/publish-skill/old.md", size: oldBytes.byteLength, etag: "old-etag" },
        ];
      }
      if (bucket === "workspace-bucket" && prefix === "fs-ns/.skills/publish-skill/") {
        return [
          { key: `${prefix}.stage.json`, size: JSON.stringify(manifest).length },
          { key: `${prefix}SKILL.md`, size: editedSkill.length },
        ];
      }
      return [];
    });
    readS3BytesMock.mockImplementation(async () => new TextEncoder().encode(editedSkill));

    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");
    await publishStagedSkillBundle(["acct_test/publish-skill"], "acct_test/publish-skill", "fs-ns");

    // old.md (dropped from the staged bundle) is deleted only after every write completes.
    expect(s3Ops).toContain("delete");
    expect(s3Ops.lastIndexOf("write")).toBeLessThan(s3Ops.indexOf("delete"));
    expect(s3Deletes).toEqual([{ bucket: "test-skills-bucket", key: "acct_test/publish-skill/old.md" }]);
  });

  it("throws when the skill is not configured for the agent", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");

    await expect(publishStagedSkillBundle([], "acct_test/publish-skill", "fs-ns"))
      .rejects.toThrow("Skill is not configured for this agent: acct_test/publish-skill");
  });

  it("throws when no staged checkout manifest exists", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });
    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");

    await expect(publishStagedSkillBundle(["acct_test/publish-skill"], "acct_test/publish-skill", "fs-ns"))
      .rejects.toThrow("No staged skill checkout found for acct_test/publish-skill");
  });

  it("throws when the staged manifest belongs to a different skill", async () => {
    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith(".stage.json")) {
        return JSON.stringify({ version: 1, skillPath: "acct_test/other-skill", stagedAt: "t", files: [] });
      }
      throw new Error("NoSuchKey");
    });
    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");

    await expect(publishStagedSkillBundle(["acct_test/publish-skill"], "acct_test/publish-skill", "fs-ns"))
      .rejects.toThrow("No staged skill checkout found for acct_test/publish-skill");
  });

  it("throws when the source skill changed after checkout without force", async () => {
    const skillContent = createSkillMarkdown("publish-skill", "Publish skill");
    const manifest = {
      version: 1,
      skillPath: "acct_test/publish-skill",
      stagedAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "SKILL.md", sourceKey: "acct_test/publish-skill/SKILL.md", etag: "stale-etag", size: skillContent.length }],
    };

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith(".stage.json")) return JSON.stringify(manifest);
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === "test-skills-bucket" && prefix === "acct_test/publish-skill/") {
        return [{ key: "acct_test/publish-skill/SKILL.md", size: skillContent.length, etag: "fresh-etag" }];
      }
      return [];
    });
    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");

    await expect(publishStagedSkillBundle(["acct_test/publish-skill"], "acct_test/publish-skill", "fs-ns"))
      .rejects.toThrow("Source skill changed after checkout: acct_test/publish-skill");
  });

  it("publishes with force even when the source skill changed after checkout", async () => {
    const editedSkill = createSkillMarkdown("publish-skill", "Publish skill", "# Forced");
    const manifest = {
      version: 1,
      skillPath: "acct_test/publish-skill",
      stagedAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "SKILL.md", sourceKey: "acct_test/publish-skill/SKILL.md", etag: "stale-etag", size: editedSkill.length }],
    };

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (bucket: string, key: string) => {
      if (bucket === "workspace-bucket" && key.endsWith(".stage.json")) return JSON.stringify(manifest);
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === "test-skills-bucket" && prefix === "acct_test/publish-skill/") {
        return [{ key: "acct_test/publish-skill/SKILL.md", size: editedSkill.length, etag: "fresh-etag" }];
      }
      if (bucket === "workspace-bucket" && prefix === "fs-ns/.skills/publish-skill/") {
        return [
          { key: `${prefix}.stage.json`, size: JSON.stringify(manifest).length },
          { key: `${prefix}SKILL.md`, size: editedSkill.length },
        ];
      }
      return [];
    });
    readS3BytesMock.mockImplementation(async () => new TextEncoder().encode(editedSkill));

    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");
    const result = await publishStagedSkillBundle(
      ["acct_test/publish-skill"],
      "acct_test/publish-skill",
      "fs-ns",
      { force: true },
    );

    expect(result.files.map((file) => file.path)).toEqual(["SKILL.md"]);
    expect(s3Writes).toContainEqual({
      bucket: "test-skills-bucket",
      key: "acct_test/publish-skill/SKILL.md",
      body: new TextEncoder().encode(editedSkill),
      options: { contentType: "text/plain; charset=utf-8" },
    });
  });

  it("throws when the published SKILL.md renames the skill", async () => {
    const skillContent = createSkillMarkdown("publish-skill", "Publish skill");
    const renamedSkill = createSkillMarkdown("renamed-skill", "Renamed skill");
    const manifest = {
      version: 1,
      skillPath: "acct_test/publish-skill",
      stagedAt: "2026-01-01T00:00:00.000Z",
      files: [{ path: "SKILL.md", sourceKey: "acct_test/publish-skill/SKILL.md", etag: "skill-etag", size: skillContent.length }],
    };

    process.env.FILESYSTEM_BUCKET_NAME = "workspace-bucket";
    readS3TextMock.mockImplementation(async (bucket: string, key: string) => {
      if (bucket === "workspace-bucket" && key.endsWith(".stage.json")) return JSON.stringify(manifest);
      throw new Error("NoSuchKey");
    });
    listS3PrefixMock.mockImplementation(async (bucket: string, prefix: string) => {
      if (bucket === "test-skills-bucket" && prefix === "acct_test/publish-skill/") {
        return [{ key: "acct_test/publish-skill/SKILL.md", size: skillContent.length, etag: "skill-etag" }];
      }
      if (bucket === "workspace-bucket" && prefix === "fs-ns/.skills/publish-skill/") {
        return [
          { key: `${prefix}.stage.json`, size: JSON.stringify(manifest).length },
          { key: `${prefix}SKILL.md`, size: renamedSkill.length },
        ];
      }
      return [];
    });
    readS3BytesMock.mockImplementation(async () => new TextEncoder().encode(renamedSkill));

    const { publishStagedSkillBundle } = await import("../functions/harness-processing/skills.ts");

    await expect(publishStagedSkillBundle(["acct_test/publish-skill"], "acct_test/publish-skill", "fs-ns"))
      .rejects.toThrow("Published SKILL.md name must remain publish-skill");
    // Nothing is written back when validation rejects the rename.
    expect(s3Writes.some((write) => write.bucket === "test-skills-bucket")).toBe(false);
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
