"use node";

// Default-runtime callers reach S3 through these; Node actions use model/skills directly.

import { v } from "convex/values";
import { z } from "zod/mini";

import { internalAction } from "../_generated/server";
import { parseInput } from "../model/inputSchema";
import { configObject, parseOr } from "../model/storedJson";
import {
  createJsonSkillFiles,
  createOrReplaceSkill,
  deleteSkill,
  fetchGitHubSkillFiles,
  getSkill,
  listAccountSkills,
  validateSkillBundle,
  type SkillBundleFile,
  type SkillMetadata,
  type StoredSkill,
} from "../model/skills";
import { ClientError } from "../model/clientError";

const SKILL_INPUT = z.looseObject(
  {
    source: z.optional(z.unknown()),
    files: z.optional(z.unknown()),
    url: z.optional(z.unknown()),
  },
  { error: "Request body must be an object" },
);
const JSON_SKILL = z.looseObject({
  name: z.string(),
  description: z.string(),
  content: z.string(),
});
const SKILL_FILE = z.looseObject({
  path: z.string(),
  contentBase64: z.string(),
});

const skillMetadata = v.object({
  name: v.string(),
  description: v.string(),
  path: v.string(),
});
const storedSkill = v.object({
  name: v.string(),
  description: v.string(),
  path: v.string(),
  files: v.array(v.object({ path: v.string(), size: v.optional(v.number()) })),
});

export const createSkill = internalAction({
  args: {
    accountId: v.id("accounts"),
    input: v.any(),
    expectedName: v.optional(v.string()),
  },
  returns: storedSkill,
  handler: async (_ctx, args): Promise<StoredSkill> => {
    const files = await validatedSkillFiles(args.input, args.expectedName);

    return await createOrReplaceSkill(args.accountId, files);
  },
});

export const validateSkills = internalAction({
  args: { skills: v.array(v.object({ name: v.string(), files: v.any() })) },
  returns: v.null(),
  handler: async (_ctx, args): Promise<null> => {
    for (const skill of args.skills) {
      await validatedSkillFiles(
        { source: "files", files: skill.files },
        skill.name,
      );
    }

    return null;
  },
});

export const list = internalAction({
  args: { accountId: v.id("accounts") },
  returns: v.array(skillMetadata),
  handler: async (_ctx, args): Promise<SkillMetadata[]> => {
    return await listAccountSkills(args.accountId);
  },
});

export const get = internalAction({
  args: { accountId: v.id("accounts"), skillName: v.string() },
  returns: v.union(storedSkill, v.null()),
  handler: async (_ctx, args): Promise<StoredSkill | null> => {
    return await getSkill(args.accountId, args.skillName);
  },
});

export const remove = internalAction({
  args: { accountId: v.id("accounts"), skillName: v.string() },
  returns: v.boolean(),
  handler: async (_ctx, args): Promise<boolean> => {
    return (await deleteSkill(args.accountId, args.skillName)) > 0;
  },
});

async function resolveSkillBundleFiles(
  input: unknown,
): Promise<SkillBundleFile[]> {
  const record = parseInput(SKILL_INPUT, input, "");
  switch (record.source) {
    case "json": {
      const skill = parseOr(JSON_SKILL, record);
      if (!skill) {
        throw new ClientError(
          "JSON skills require name, description, and content strings",
        );
      }

      return createJsonSkillFiles(skill.name, skill.description, skill.content);
    }
    case "files": {
      if (!Array.isArray(record.files) || record.files.length === 0) {
        throw new ClientError("files must be a non-empty array");
      }

      return record.files.map((item: unknown) => {
        if (!parseOr(configObject, item)) {
          throw new ClientError("Each file must be an object");
        }
        const candidate = parseOr(SKILL_FILE, item);
        if (!candidate) {
          throw new ClientError("Each file requires path and contentBase64");
        }

        return {
          path: candidate.path,
          bytes: new Uint8Array(Buffer.from(candidate.contentBase64, "base64")),
          ...(typeof candidate.contentType === "string"
            ? { contentType: candidate.contentType }
            : {}),
        };
      });
    }
    case "github":
      return fetchGitHubSkillFiles(record.url);
    default:
      throw new ClientError("source must be one of: json, files, github");
  }
}

async function validatedSkillFiles(
  input: unknown,
  expectedName: string | undefined,
): Promise<SkillBundleFile[]> {
  const files = await resolveSkillBundleFiles(input);
  const { metadata } = validateSkillBundle(files);
  if (expectedName !== undefined && metadata.name !== expectedName) {
    throw new ClientError(
      "Skill name in SKILL.md must match the requested skill name",
    );
  }

  return files;
}
