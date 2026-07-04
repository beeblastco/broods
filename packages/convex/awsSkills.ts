"use node";

/**
 * Node-runtime internal actions for S3 skill storage. Callers in the default
 * runtime (cliHttp, configHttp) reach S3 through these; Node actions
 * (skillsPublic) import model/skills directly instead.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
    createJsonSkillFiles,
    createOrReplaceSkill,
    deleteSkill,
    fetchGitHubSkillFiles,
    getSkill,
    listAccountSkills,
    type SkillBundleFile,
} from "./model/skills";

const skillMetadata = v.object({ name: v.string(), description: v.string(), path: v.string() });
const storedSkill = v.object({
    name: v.string(),
    description: v.string(),
    path: v.string(),
    files: v.array(v.object({ path: v.string(), size: v.optional(v.number()) })),
});

/**
 * Validate and store a skill bundle from any supported source (files, json,
 * or github), replacing an existing skill of the same name.
 * @param accountId account id owning the skill
 * @param input the create-skill request body (source discriminated)
 * @param expectedName when set, the SKILL.md name must match or the write is rolled back
 * @returns the stored skill's metadata and manifest
 */
export const createSkill = internalAction({
    args: {
        accountId: v.id("accounts"),
        input: v.any(),
        expectedName: v.optional(v.string()),
    },
    returns: storedSkill,
    handler: async (_ctx, args) => {
        const skill = await createOrReplaceSkill(args.accountId, await resolveSkillBundleFiles(args.input));
        if (args.expectedName !== undefined && skill.name !== args.expectedName) {
            await deleteSkill(args.accountId, skill.name).catch(() => {});
            throw new Error("Skill name in SKILL.md must match the requested skill name");
        }

        return skill;
    },
});

/**
 * List an account's stored skills.
 * @param accountId account id owning the skills
 * @returns skill metadata entries
 */
export const list = internalAction({
    args: { accountId: v.id("accounts") },
    returns: v.array(skillMetadata),
    handler: async (_ctx, args) => {
        return await listAccountSkills(args.accountId);
    },
});

/**
 * Load one stored skill's metadata and file manifest.
 * @param accountId account id owning the skill
 * @param skillName the skill name
 * @returns the stored skill, or null when it does not exist
 */
export const get = internalAction({
    args: { accountId: v.id("accounts"), skillName: v.string() },
    returns: v.union(storedSkill, v.null()),
    handler: async (_ctx, args) => {
        return await getSkill(args.accountId, args.skillName);
    },
});

/**
 * Delete one stored skill.
 * @param accountId account id owning the skill
 * @param skillName the skill name
 * @returns true when any objects were deleted
 */
export const remove = internalAction({
    args: { accountId: v.id("accounts"), skillName: v.string() },
    returns: v.boolean(),
    handler: async (_ctx, args) => {
        return (await deleteSkill(args.accountId, args.skillName)) > 0;
    },
});

/**
 * Resolve a create-skill request body into bundle files, mirroring core's
 * former `resolveSkillBundleFiles` contract (sources: json, files, github).
 * @param input the request body
 * @returns the bundle files to validate and store
 * @throws when the body or source is invalid
 */
async function resolveSkillBundleFiles(input: unknown): Promise<SkillBundleFile[]> {
    if (!input || typeof input !== "object") {
        throw new Error("Request body must be an object");
    }

    const record = input as Record<string, unknown>;
    switch (record.source) {
        case "json": {
            if (typeof record.name !== "string" || typeof record.description !== "string" || typeof record.content !== "string") {
                throw new Error("JSON skills require name, description, and content strings");
            }

            return createJsonSkillFiles(record.name, record.description, record.content);
        }
        case "files": {
            if (!Array.isArray(record.files) || record.files.length === 0) {
                throw new Error("files must be a non-empty array");
            }

            return record.files.map((item) => {
                if (!item || typeof item !== "object") {
                    throw new Error("Each file must be an object");
                }
                const candidate = item as Record<string, unknown>;
                if (typeof candidate.path !== "string" || typeof candidate.contentBase64 !== "string") {
                    throw new Error("Each file requires path and contentBase64");
                }

                return {
                    path: candidate.path,
                    bytes: new Uint8Array(Buffer.from(candidate.contentBase64, "base64")),
                    ...(typeof candidate.contentType === "string" ? { contentType: candidate.contentType } : {}),
                };
            });
        }
        case "github":
            return fetchGitHubSkillFiles(record.url);
        default:
            throw new Error("source must be one of: json, files, github");
    }
}
