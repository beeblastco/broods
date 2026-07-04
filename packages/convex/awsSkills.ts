"use node";

/**
 * Node-runtime S3 skill bundle writer for Convex config-plane sync. Callers in
 * the default runtime (cliHttp) reach S3 through this internal action; Node
 * actions (skillsPublic) import model/skills directly instead.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { createOrReplaceSkill, deleteSkill } from "./model/skills";

/**
 * Validate and store a skill bundle in the skills bucket, replacing any
 * existing skill of the same name.
 * @param accountId account id owning the skill
 * @param expectedName when set, the SKILL.md name must match or the write is rolled back
 * @param files bundle files with base64-encoded contents
 * @returns the stored skill's name, description, and S3 path
 */
export const putSkillBundle = internalAction({
    args: {
        accountId: v.id("accounts"),
        expectedName: v.optional(v.string()),
        files: v.array(v.object({
            path: v.string(),
            contentBase64: v.string(),
            contentType: v.optional(v.string()),
        })),
    },
    returns: v.object({ name: v.string(), description: v.string(), path: v.string() }),
    handler: async (_ctx, args) => {
        const skill = await createOrReplaceSkill(args.accountId, args.files.map((file) => ({
            path: file.path,
            bytes: new Uint8Array(Buffer.from(file.contentBase64, "base64")),
            ...(file.contentType !== undefined ? { contentType: file.contentType } : {}),
        })));
        if (args.expectedName !== undefined && skill.name !== args.expectedName) {
            await deleteSkill(args.accountId, skill.name).catch(() => {});
            throw new Error("Skill name in SKILL.md must match the manifest resource name");
        }

        return { name: skill.name, description: skill.description, path: skill.path };
    },
});
