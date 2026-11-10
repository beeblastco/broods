import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { S3ObjectInfo } from "../../../../apps/core/src/shared/s3.ts";

const S3_PATH = import.meta.resolve("../../../../apps/core/src/shared/s3.ts");
const realS3 = await import(S3_PATH);
const ORIGINAL_ENV = { ...process.env };
const NAMESPACE = "fs-agent15";
const SKILL_TEXT =
  "---\nname: report-skill\ndescription: Builds reports\n---\n\nWrite the report.\n";

const deletes: string[] = [];
const copies: string[] = [];
let listings: Record<string, S3ObjectInfo[]> = {};

await mock.module(S3_PATH, (): object => ({
  ...realS3,
  readS3Text: async (): Promise<string> => SKILL_TEXT,
  readS3TextHead: async (): Promise<string> => SKILL_TEXT,
  readS3Bytes: async (): Promise<Uint8Array> =>
    new TextEncoder().encode(SKILL_TEXT),
  listS3Prefix: async (
    _bucket: string,
    prefix: string,
  ): Promise<S3ObjectInfo[]> => listings[prefix] ?? [],
  ensureS3DirectoryMarkers: async (): Promise<void> => {},
  copyS3Object: async (
    _sourceBucket: string,
    _sourceKey: string,
    _destinationBucket: string,
    destinationKey: string,
  ): Promise<void> => {
    copies.push(destinationKey);
  },
  deleteS3Object: async (_bucket: string, key: string): Promise<void> => {
    deletes.push(key);
  },
}));

const { loadConfiguredSkillPrompt } =
  await import("../../../../apps/core/src/harness/skills.ts");

function object(key: string): S3ObjectInfo {
  return { key: key, size: 10, etag: "etag" } as S3ObjectInfo;
}

beforeEach((): void => {
  process.env.SKILLS_BUCKET_NAME = "agent15-skills";
  delete process.env.FILESYSTEM_BUCKET_NAME;
  deletes.length = 0;
  copies.length = 0;
  listings = {};
});

afterEach((): void => {
  process.env = { ...ORIGINAL_ENV };
});

describe("loadConfiguredSkillPrompt", (): void => {
  test("refuses a run with no account", async (): Promise<void> => {
    await expect(
      loadConfiguredSkillPrompt(
        undefined,
        ["acct_one/report-skill"],
        "acct_one/report-skill",
      ),
    ).rejects.toThrow("Skills require an account-scoped run");
  });

  test("says nothing is staged when the workspace bucket is unset", async (): Promise<void> => {
    listings["acct_one/report-skill/"] = [
      object("acct_one/report-skill/SKILL.md"),
    ];
    const result = await loadConfiguredSkillPrompt(
      "acct_one",
      ["acct_one/report-skill"],
      "acct_one/report-skill",
      [],
      NAMESPACE,
    );

    expect(result.stagedPath).toBeUndefined();
    expect(result.stagedFiles).toEqual([]);
    expect(result.prompt.content).toContain(
      "No sandbox staging path is available",
    );
  });

  test("stages the bundle with SKILL.md first, sorts the rest and prunes stale files", async (): Promise<void> => {
    process.env.FILESYSTEM_BUCKET_NAME = "agent15-workspace";
    listings["acct_one/report-skill/"] = [
      object("acct_one/report-skill/scripts/b.py"),
      object("acct_one/report-skill/notes/"),
      object("acct_one/report-skill/SKILL.md"),
      object("acct_one/report-skill/scripts/a.py"),
    ];
    listings[`${NAMESPACE}/.claude/skills/report-skill/`] = [
      object(`${NAMESPACE}/.claude/skills/report-skill/old.txt`),
      object(`${NAMESPACE}/.claude/skills/report-skill/scripts/`),
      object(`${NAMESPACE}/.claude/skills/report-skill/scripts/a.py`),
    ];
    const result = await loadConfiguredSkillPrompt(
      "acct_one",
      ["acct_one/report-skill"],
      "acct_one/report-skill",
      [],
      NAMESPACE,
    );

    expect(result.stagedFiles).toEqual([
      "SKILL.md",
      "scripts/a.py",
      "scripts/b.py",
    ]);
    expect(deletes).toEqual([
      `${NAMESPACE}/.claude/skills/report-skill/old.txt`,
    ]);
    expect(copies).toContain(
      `${NAMESPACE}/.claude/skills/report-skill/scripts/b.py`,
    );
  });
});
