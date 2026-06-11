/**
 * Account-management skill CRUD tests.
 * Cover skill installation, removal, listing, validation, and GitHub import.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { S3ObjectInfo } from "../functions/_shared/s3.ts";

const ORIGINAL_ENV = { ...process.env };
const originalFetch = globalThis.fetch;

const s3ObjectExistsMock = mock(async (_bucket: string, _key: string) => false);
const listS3PrefixMock = mock(async (_bucket: string, _prefix: string) => [] as S3ObjectInfo[]);
const readS3TextMock = mock(async (_bucket: string, _key: string): Promise<string> => {
  throw new Error("NoSuchKey");
});
const writeS3ObjectMock = mock(async (_bucket: string, _key: string, _body: Uint8Array, _options?: { contentType?: string }) => 0);
const deleteS3PrefixMock = mock(async (_bucket: string, _prefix: string) => 0);

mock.module("../functions/_shared/s3.ts", () => ({
  s3ObjectExists: s3ObjectExistsMock,
  isMissingS3Error: (error: unknown) =>
    error instanceof Error && error.message === "NoSuchKey",
  listS3Prefix: listS3PrefixMock,
  readS3Text: readS3TextMock,
  writeS3Object: writeS3ObjectMock,
  deleteS3Prefix: deleteS3PrefixMock,
  readS3Bytes: mock(async () => new Uint8Array()),
  copyS3Object: mock(async () => {}),
  deleteS3Object: mock(async () => {}),
  ensureS3DirectoryMarkers: mock(async () => {}),
}));

beforeEach(() => {
  process.env.SKILLS_BUCKET_NAME = "test-skills-bucket";
  s3ObjectExistsMock.mockClear();
  listS3PrefixMock.mockClear();
  readS3TextMock.mockClear();
  writeS3ObjectMock.mockClear();
  deleteS3PrefixMock.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  globalThis.fetch = originalFetch;
});

function createSkillMarkdown(name: string, description: string, content = "# Instructions\nUse this skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`;
}

describe("createOrReplaceSkill", () => {
  it("creates a skill from JSON source", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    const result = await createOrReplaceSkill("acct_test", {
      source: "json",
      name: "pdf-helper",
      description: "Processes PDF files",
      content: "# PDF Helper\nExtract text from PDFs.",
    });

    expect(result.name).toBe("pdf-helper");
    expect(result.description).toBe("Processes PDF files");
    expect(result.path).toBe("acct_test/pdf-helper");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe("SKILL.md");
  });

  it("rejects invalid input type", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", "not-an-object")).rejects.toThrow(
      "Request body must be an object",
    );
  });

  it("rejects null input", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", null)).rejects.toThrow(
      "Request body must be an object",
    );
  });

  it("rejects unknown source", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", { source: "unknown" })).rejects.toThrow(
      "source must be one of: json, files, github",
    );
  });

  it("rejects JSON skill with missing fields", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "json",
      name: "test-skill",
    })).rejects.toThrow("JSON skills require name, description, and content strings");
  });

  it("rejects JSON skill with invalid name", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "json",
      name: "Invalid-Name",
      description: "ok",
      content: "content",
    })).rejects.toThrow("Skill name must be lowercase");
  });

  it("rejects JSON skill with invalid description", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "json",
      name: "test-skill",
      description: "<tag>bad</tag>",
      content: "content",
    })).rejects.toThrow("Skill description must be non-empty");
  });

  it("creates a skill from file upload source", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("upload-skill", "Uploaded skill");
    const contentBase64 = Buffer.from(content).toString("base64");

    const result = await createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        {
          path: "SKILL.md",
          contentBase64,
          contentType: "text/markdown",
        },
      ],
    });

    expect(result.name).toBe("upload-skill");
    expect(result.description).toBe("Uploaded skill");
    expect(result.files).toHaveLength(1);
  });

  it("rejects empty files array", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [],
    })).rejects.toThrow("files must be a non-empty array");
  });

  it("rejects files that is not an array", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: "not-array",
    })).rejects.toThrow("files must be a non-empty array");
  });

  it("rejects file entry without path", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [{ contentBase64: "dGVzdA==" }],
    })).rejects.toThrow("Each file requires path and contentBase64");
  });

  it("rejects file entry without contentBase64", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [{ path: "SKILL.md" }],
    })).rejects.toThrow("Each file requires path and contentBase64");
  });

  it("rejects duplicate file paths in bundle", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("dup-skill", "Duplicate test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Duplicate skill file path: SKILL.md");
  });

  it("rejects skill bundle missing SKILL.md", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "README.md", contentBase64: Buffer.from("# Readme").toString("base64") },
      ],
    })).rejects.toThrow("Skill bundle must include SKILL.md at the root");
  });

  it("rejects file with path traversal", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("traversal-skill", "Traversal test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "../SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Invalid skill file path");
  });

  it("rejects unsupported file extension", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const skillContent = createSkillMarkdown("ext-skill", "Extension test");
    const skillBase64 = Buffer.from(skillContent).toString("base64");
    const binaryBase64 = Buffer.from(new Uint8Array([0x00, 0x01, 0x02, 0x03])).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64: skillBase64 },
        { path: "data.bin", contentBase64: binaryBase64 },
      ],
    })).rejects.toThrow("Skill file must be a supported text file: data.bin");
  });

  it("detects binary content in text files via null byte", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const skillContent = createSkillMarkdown("binary-skill", "Binary test");
    const skillBase64 = Buffer.from(skillContent).toString("base64");
    const binaryContent = new Uint8Array([0x50, 0x44, 0x46, 0x00, 0x25]);
    const binaryBase64 = Buffer.from(binaryContent).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64: skillBase64 },
        { path: "data.txt", contentBase64: binaryBase64 },
      ],
    })).rejects.toThrow("Skill file must be a supported text file: data.txt");
  });

  it("trims content and wraps in frontmatter for JSON skills", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await createOrReplaceSkill("acct_test", {
      source: "json",
      name: "format-skill",
      description: "Format test",
      content: "  # Content with whitespace  \n",
    });

    const writeCall = writeS3ObjectMock.mock.calls[0];
    const body = writeCall?.[2] as Uint8Array;
    const text = new TextDecoder().decode(body);

    expect(text).toContain("---\nname: format-skill\ndescription: Format test\n---");
    expect(text).toContain("# Content with whitespace");
  });

  it("validates content type for JSON files", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        {
          path: "SKILL.md",
          contentBase64: Buffer.from(createSkillMarkdown("json-skill", "JSON skill")).toString("base64"),
        },
        {
          path: "config.json",
          contentBase64: Buffer.from('{"key": "value"}').toString("base64"),
        },
      ],
    });

    const jsonWriteCall = writeS3ObjectMock.mock.calls.find(
      (call) => call[1]?.includes("config.json"),
    );
    expect(jsonWriteCall?.[3]?.contentType).toBe("application/json");
  });

  it("validates content type for non-JSON text files", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        {
          path: "SKILL.md",
          contentBase64: Buffer.from(createSkillMarkdown("text-skill", "Text skill")).toString("base64"),
        },
        {
          path: "script.py",
          contentBase64: Buffer.from("print('hello')").toString("base64"),
        },
      ],
    });

    const pyWriteCall = writeS3ObjectMock.mock.calls.find(
      (call) => call[1]?.includes("script.py"),
    );
    expect(pyWriteCall?.[3]?.contentType).toBe("text/plain; charset=utf-8");
  });
});

describe("listAccountSkills", () => {
  it("returns empty array when no skills exist", async () => {
    listS3PrefixMock.mockResolvedValue([]);

    const { listAccountSkills } = await import("../functions/account-manage/skills.ts");

    const result = await listAccountSkills("acct_test");

    expect(result).toEqual([]);
  });

  it("returns list of skills with metadata", async () => {
    const skill1Content = createSkillMarkdown("skill-one", "First skill");
    const skill2Content = createSkillMarkdown("skill-two", "Second skill");

    listS3PrefixMock.mockImplementation(async (_bucket: string, prefix: string) => {
      if (prefix === "acct_test/") {
        return [
          { key: "acct_test/skill-one/SKILL.md", size: skill1Content.length },
          { key: "acct_test/skill-two/SKILL.md", size: skill2Content.length },
        ];
      }
      if (prefix === "acct_test/skill-one/") {
        return [{ key: "acct_test/skill-one/SKILL.md", size: skill1Content.length }];
      }
      if (prefix === "acct_test/skill-two/") {
        return [{ key: "acct_test/skill-two/SKILL.md", size: skill2Content.length }];
      }
      return [];
    });

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.includes("skill-one")) return skill1Content;
      if (key.includes("skill-two")) return skill2Content;
      throw new Error("NoSuchKey");
    });

    s3ObjectExistsMock.mockResolvedValue(true);

    const { listAccountSkills } = await import("../functions/account-manage/skills.ts");

    const result = await listAccountSkills("acct_test");

    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("skill-one");
    expect(result[1]?.name).toBe("skill-two");
    expect(result[0]?.path).toBe("acct_test/skill-one");
  });
});

describe("getSkill", () => {
  it("returns null when skill does not exist", async () => {
    readS3TextMock.mockImplementation(async () => {
      throw new Error("NoSuchKey");
    });

    const { getSkill } = await import("../functions/account-manage/skills.ts");

    const result = await getSkill("acct_test", "missing-skill");

    expect(result).toBeNull();
  });

  it("returns skill metadata and file list", async () => {
    const content = createSkillMarkdown("my-skill", "A test skill");

    readS3TextMock.mockImplementation(async (_bucket: string, key: string) => {
      if (key.endsWith("SKILL.md")) return content;
      throw new Error("NoSuchKey");
    });

    listS3PrefixMock.mockImplementation(async (_bucket: string, prefix: string) => {
      return [
        { key: "acct_test/my-skill/SKILL.md", size: content.length },
        { key: "acct_test/my-skill/README.md", size: 100 },
      ];
    });

    s3ObjectExistsMock.mockResolvedValue(true);

    const { getSkill } = await import("../functions/account-manage/skills.ts");

    const result = await getSkill("acct_test", "my-skill");

    expect(result).not.toBeNull();
    expect(result?.name).toBe("my-skill");
    expect(result?.description).toBe("A test skill");
    expect(result?.path).toBe("acct_test/my-skill");
    expect(result?.files).toHaveLength(2);
    expect(result?.files[0]?.path).toBe("SKILL.md");
    expect(result?.files[1]?.path).toBe("README.md");
  });

  it("rejects invalid skill name", async () => {
    const { getSkill } = await import("../functions/account-manage/skills.ts");

    await expect(getSkill("acct_test", "Invalid-Name")).rejects.toThrow(
      "Skill name must be lowercase",
    );
  });
});

describe("deleteSkill", () => {
  it("returns false when skill does not exist", async () => {
    s3ObjectExistsMock.mockResolvedValue(false);

    const { deleteSkill } = await import("../functions/account-manage/skills.ts");

    const result = await deleteSkill("acct_test", "missing-skill");

    expect(result).toBe(false);
  });

  it("deletes existing skill and returns true", async () => {
    s3ObjectExistsMock.mockResolvedValue(true);
    deleteS3PrefixMock.mockResolvedValue(2);

    const { deleteSkill } = await import("../functions/account-manage/skills.ts");

    const result = await deleteSkill("acct_test", "test-skill");

    expect(result).toBe(true);
    expect(deleteS3PrefixMock).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid skill name", async () => {
    const { deleteSkill } = await import("../functions/account-manage/skills.ts");

    await expect(deleteSkill("acct_test", "Bad-Name")).rejects.toThrow(
      "Skill name must be lowercase",
    );
  });
});

describe("deleteAccountSkills", () => {
  it("deletes all skills for an account", async () => {
    deleteS3PrefixMock.mockResolvedValue(5);

    const { deleteAccountSkills } = await import("../functions/account-manage/skills.ts");

    const result = await deleteAccountSkills("acct_test");

    expect(result).toBe(5);
    expect(deleteS3PrefixMock).toHaveBeenCalledWith("test-skills-bucket", "acct_test/");
  });
});

describe("GitHub skill import", () => {
  it("rejects non-https GitHub URLs", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "github",
      url: "http://github.com/owner/repo/tree/main/skill",
    })).rejects.toThrow("GitHub skill URL must use https://github.com");
  });

  it("rejects non-tree GitHub URLs", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "github",
      url: "https://github.com/owner/repo/blob/main/skill",
    })).rejects.toThrow("GitHub skill URL must be https://github.com/{owner}/{repo}/tree/{ref}/{path}");
  });

  it("rejects GitHub URLs with path traversal", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "github",
      url: "https://github.com/owner/repo/tree/main/../secret",
    })).rejects.toThrow("Invalid skill file path");
  });

  it("rejects empty URL", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "github",
      url: "",
    })).rejects.toThrow("url must be a non-empty string");
  });

  it("rejects non-string URL", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "github",
      url: 123,
    })).rejects.toThrow("url must be a non-empty string");
  });

  it("handles failed GitHub download", async () => {
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
    })) as never;

    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "github",
      url: "https://github.com/owner/repo/tree/main/skill",
    })).rejects.toThrow("Failed to download GitHub skill archive: 404");
  });
});

describe("file upload edge cases", () => {
  it("rejects file entry that is not an object", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: ["not-an-object"],
    })).rejects.toThrow("Each file must be an object");
  });

  it("rejects file entry that is null", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [null],
    })).rejects.toThrow("Each file must be an object");
  });

  it("normalizes file paths by trimming whitespace", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("trim-skill", "Trim test");
    const contentBase64 = Buffer.from(content).toString("base64");

    const result = await createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "  SKILL.md  ", contentBase64 },
      ],
    });

    expect(result.files[0]?.path).toBe("SKILL.md");
  });

  it("rejects file path with backslashes", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("backslash-skill", "Backslash test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "subdir\\SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Invalid skill file path");
  });

  it("rejects file path starting with slash", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("slash-skill", "Slash test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "/SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Invalid skill file path");
  });

  it("rejects file path with empty segments", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("empty-seg-skill", "Empty segment test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "subdir//SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Invalid skill file path");
  });

  it("rejects file path with null bytes", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("null-skill", "Null byte test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "subdir\0SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Invalid skill file path");
  });
});

describe("skill name validation", () => {
  it("rejects skill names containing anthropic", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("anthropic-helper", "Anthropic test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill name must be lowercase");
  });

  it("rejects skill names containing claude", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("claude-helper", "Claude test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill name must be lowercase");
  });

  it("rejects skill names with XML tags", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("skill<tag>", "XML test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill name must be lowercase");
  });

  it("rejects skill name exceeding max length", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const longName = "a".repeat(65);
    const content = createSkillMarkdown(longName, "Long name test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill name must be lowercase");
  });

  it("rejects empty skill name", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("", "Empty name test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill name must be lowercase");
  });

  it("rejects skill name with uppercase letters", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("My-Skill", "Uppercase test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill name must be lowercase");
  });

  it("rejects skill name with special characters", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("my_skill!", "Special chars test");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill name must be lowercase");
  });
});

describe("skill description validation", () => {
  it("rejects empty description after trim", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("desc-skill", "   ");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill description must be non-empty");
  });

  it("rejects description with XML tags", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("xml-desc-skill", "A <tag>description</tag>");
    const contentBase64 = Buffer.from(content).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    })).rejects.toThrow("Skill description must be non-empty");
  });
});

describe("account-scoped skill paths", () => {
  it("formats skill paths with account prefix", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const content = createSkillMarkdown("scoped-skill", "Scoped test");
    const contentBase64 = Buffer.from(content).toString("base64");

    const result = await createOrReplaceSkill("acct_123", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64 },
      ],
    });

    expect(result.path).toBe("acct_123/scoped-skill");
  });

  it("lists skills scoped to specific account", async () => {
    const skillContent = createSkillMarkdown("account-skill", "Account scoped");

    listS3PrefixMock.mockImplementation(async (_bucket: string, prefix: string) => {
      if (prefix === "acct_456/") {
        return [{ key: "acct_456/account-skill/SKILL.md", size: skillContent.length }];
      }
      if (prefix === "acct_456/account-skill/") {
        return [{ key: "acct_456/account-skill/SKILL.md", size: skillContent.length }];
      }
      return [];
    });

    readS3TextMock.mockResolvedValue(skillContent);
    s3ObjectExistsMock.mockResolvedValue(true);

    const { listAccountSkills } = await import("../functions/account-manage/skills.ts");

    const result = await listAccountSkills("acct_456");

    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("acct_456/account-skill");
  });

  it("deletes skills scoped to specific account only", async () => {
    deleteS3PrefixMock.mockResolvedValue(3);

    const { deleteAccountSkills } = await import("../functions/account-manage/skills.ts");

    await deleteAccountSkills("acct_789");

    expect(deleteS3PrefixMock).toHaveBeenCalledWith("test-skills-bucket", "acct_789/");
  });
});

describe("skill file size validation", () => {
  it("rejects skill file exceeding 5 MB limit", async () => {
    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");
    const largeContent = "x".repeat(5 * 1024 * 1024 + 1);
    const largeBase64 = Buffer.from(largeContent).toString("base64");

    await expect(createOrReplaceSkill("acct_test", {
      source: "files",
      files: [
        { path: "SKILL.md", contentBase64: largeBase64 },
      ],
    })).rejects.toThrow("Skill file is too large: SKILL.md");
  });
});

describe("GitHub skill import success path", () => {
  it("handles empty GitHub archive", async () => {
    const emptyTarGz = await createEmptyTarGz();

    globalThis.fetch = mock(async () => ({
      ok: true,
      blob: async () => new Blob([emptyTarGz]),
    })) as never;

    const { createOrReplaceSkill } = await import("../functions/account-manage/skills.ts");

    await expect(createOrReplaceSkill("acct_test", {
      source: "github",
      url: "https://github.com/owner/repo/tree/main/skill",
    })).rejects.toThrow("GitHub archive is empty");
  });

  it("validates GitHub URL and parses archive URL correctly", async () => {
    const { parseGitHubSkillUrl } = await import("../functions/_shared/skills.ts");

    const parsed = parseGitHubSkillUrl("https://github.com/owner/repo/tree/main/skills/my-skill");

    expect(parsed.owner).toBe("owner");
    expect(parsed.repo).toBe("repo");
    expect(parsed.ref).toBe("main");
    expect(parsed.subdir).toBe("skills/my-skill");
    expect(parsed.archiveUrl).toBe("https://codeload.github.com/owner/repo/tar.gz/main");
  });
});

async function createEmptyTarGz(): Promise<Uint8Array> {
  const tmpDir = `/tmp/skill-test-empty-${Date.now()}`;
  const outFile = `${tmpDir}.tar.gz`;
  await mkdir(tmpDir, { recursive: true });
  try {
    await Bun.spawn(["tar", "czf", outFile, "-C", tmpDir, "."]).exited;
    return await readFile(outFile);
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
    try {
      await rm(outFile);
    } catch {
      // ignore
    }
  }
}
