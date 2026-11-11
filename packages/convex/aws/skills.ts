"use node";

// Default-runtime callers reach S3 through these; Node actions use model/skills directly.

import { createHash } from "node:crypto";
import { v, type Infer } from "convex/values";
import { z } from "zod/mini";

import type { Id } from "../_generated/dataModel";
import { internalAction, type ActionCtx } from "../_generated/server";
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
// An uploaded skill is its files' bytes back to back, in manifest order.
const UPLOADED_SKILL = z.looseObject({
  files: z.array(
    z.looseObject({
      path: z.string(),
      size: z.number(),
      sha256: z.string(),
      contentType: z.optional(z.string()),
    }),
  ),
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
const skillNodeFile = v.object({
  path: v.string(),
  storageId: v.id("_storage"),
  mimeType: v.string(),
  sizeBytes: v.number(),
});

export const createSkill = internalAction({
  args: {
    accountId: v.id("accounts"),
    input: v.any(),
    expectedName: v.optional(v.string()),
    filesStorageId: v.optional(v.id("_storage")),
  },
  returns: storedSkill,
  handler: async (ctx, args): Promise<StoredSkill> => {
    const files = await validatedSkillFiles(
      ctx,
      args.input,
      args.expectedName,
      args.filesStorageId,
    );

    return await createOrReplaceSkill(args.accountId, files);
  },
});

// The last reader of an uploaded skill: splits it into one stored blob per file, then deletes it.
export const storeUploadedFiles = internalAction({
  args: { files: v.any(), filesStorageId: v.id("_storage") },
  returns: v.array(skillNodeFile),
  handler: async (ctx, args): Promise<Array<Infer<typeof skillNodeFile>>> => {
    const files = await uploadedSkillFiles(ctx, args.filesStorageId, {
      files: args.files,
    });
    const stored = [];
    for (const file of files) {
      const mimeType = file.contentType ?? "text/plain";
      stored.push({
        path: file.path,
        storageId: await ctx.storage.store(
          new Blob([file.bytes.slice()], { type: mimeType }),
        ),
        mimeType: mimeType,
        sizeBytes: file.bytes.byteLength,
      });
    }
    await ctx.storage.delete(args.filesStorageId);

    return stored;
  },
});

export const validateSkills = internalAction({
  args: {
    skills: v.array(
      v.object({
        name: v.string(),
        files: v.any(),
        filesStorageId: v.optional(v.id("_storage")),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    for (const skill of args.skills) {
      await validatedSkillFiles(
        ctx,
        { source: "files", files: skill.files },
        skill.name,
        skill.filesStorageId,
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

async function uploadedSkillFiles(
  ctx: ActionCtx,
  storageId: Id<"_storage">,
  input: unknown,
): Promise<SkillBundleFile[]> {
  const declared = parseInput(UPLOADED_SKILL, input, "").files;
  const blob = await ctx.storage.get(storageId);
  if (!blob) throw new ClientError("Uploaded skill files were not found");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let offset = 0;
  const files = declared.map((file): SkillBundleFile => {
    const content = bytes.subarray(offset, offset + file.size);
    offset += file.size;
    if (createHash("sha256").update(content).digest("hex") !== file.sha256) {
      throw new ClientError(
        `Uploaded skill file ${file.path} does not match its sha256`,
      );
    }

    return {
      path: file.path,
      bytes: content,
      ...(file.contentType !== undefined
        ? { contentType: file.contentType }
        : {}),
    };
  });
  if (offset !== bytes.byteLength) {
    throw new ClientError("Uploaded skill files do not match their sizes");
  }

  return files;
}

async function validatedSkillFiles(
  ctx: ActionCtx,
  input: unknown,
  expectedName: string | undefined,
  filesStorageId?: Id<"_storage">,
): Promise<SkillBundleFile[]> {
  const files =
    filesStorageId === undefined
      ? await resolveSkillBundleFiles(input)
      : await uploadedSkillFiles(ctx, filesStorageId, input);
  const { metadata } = validateSkillBundle(files);
  if (expectedName !== undefined && metadata.name !== expectedName) {
    throw new ClientError(
      "Skill name in SKILL.md must match the requested skill name",
    );
  }

  return files;
}
