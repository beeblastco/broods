/**
 * Stage listing and creation for the `broods stage` commands.
 *
 * Creation reuses the dashboard's `duplicateStageContents`, so a cloned
 * stage carries the same agent configs, custom tools, canvas layout and
 * environment variables the dashboard duplicate button produces.
 */

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { duplicateStageContents, stageKindForName } from "./stage";
import { stageNameEquals, resolveProject } from "./model/projectScope";

const CANONICAL_NAMES = {
  development: "Development",
  production: "Production",
} as const;

const stageValidator = v.object({
  id: v.id("stages"),
  name: v.string(),
  kind: v.union(
    v.literal("development"),
    v.literal("production"),
    v.literal("custom"),
  ),
  isDefault: v.boolean(),
  deploymentRegion: v.optional(
    v.union(
      v.literal("ap-southeast-1"),
      v.literal("eu-west-1"),
      v.literal("us-east-1"),
    ),
  ),
  agentCount: v.number(),
  variableCount: v.number(),
  updatedAt: v.number(),
});

export const listByAccount = internalQuery({
  args: {
    accountId: v.id("accounts"),
    project: v.string(),
  },
  returns: v.union(v.null(), v.array(stageValidator)),
  handler: async (ctx, args) => {
    const projectDoc = await projectForAccount(
      ctx,
      args.accountId,
      args.project,
    );
    if (!projectDoc) return null;

    const stageDocs = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectDoc._id))
      .collect();
    const stages = [];
    for (const stage of stageDocs) {
      stages.push(await summarize(ctx, projectDoc._id, stage));
    }

    return stages.sort((a, b) =>
      a.isDefault !== b.isDefault
        ? a.isDefault
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
  },
});

export const createByAccount = internalMutation({
  args: {
    accountId: v.id("accounts"),
    project: v.string(),
    name: v.string(),
    duplicateFrom: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      stage: stageValidator,
      clonedFrom: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const projectDoc = await projectForAccount(
      ctx,
      args.accountId,
      args.project,
    );
    if (!projectDoc) return null;

    const trimmed = args.name.trim();
    if (!trimmed) throw new Error("Stage name is required");

    const stages = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectDoc._id))
      .collect();
    const kind = stageKindForName({ name: trimmed, kind: undefined });
    const displayName = kind === "custom" ? trimmed : CANONICAL_NAMES[kind];
    if (stages.some((entry) => stageNameEquals(entry.name, displayName))) {
      throw new Error(`Stage ${displayName} already exists`);
    }

    const source = args.duplicateFrom
      ? stages.find((entry) =>
          stageNameEquals(entry.name, args.duplicateFrom ?? ""),
        )
      : undefined;
    if (args.duplicateFrom && !source) {
      throw new Error(`Source stage ${args.duplicateFrom} was not found`);
    }

    // A brand-new stage is never the default; `cliSync.ensureStage`
    // repairs the Development-is-default invariant on the next sync.
    const now = Date.now();
    const stageId = await ctx.db.insert("stages", {
      authId: projectDoc.authId,
      projectId: projectDoc._id,
      name: displayName,
      kind: kind,
      isDefault: false,
      updatedAt: now,
    });
    if (source) {
      await duplicateStageContents(
        ctx,
        projectDoc.authId,
        projectDoc._id,
        source._id,
        stageId,
        now,
      );
    }
    await ctx.db.patch(projectDoc._id, { updatedAt: now });

    const created = await ctx.db.get(stageId);
    if (!created) throw new Error("Stage was not created");

    return {
      stage: await summarize(ctx, projectDoc._id, created),
      clonedFrom: source?.name ?? null,
    };
  },
});

async function projectForAccount(
  ctx: MutationCtx | QueryCtx,
  accountId: Id<"accounts">,
  project: string,
): Promise<Doc<"projects"> | null> {
  const account = await ctx.db.get(accountId);
  if (!account || account.status !== "active") return null;

  return await resolveProject(ctx, account, project);
}

async function summarize(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<"projects">,
  stage: Doc<"stages">,
) {
  const agents = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stage._id),
    )
    .collect();
  const variables = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stage._id),
    )
    .collect();

  return {
    id: stage._id,
    name: stage.name,
    kind: stageKindForName(stage),
    isDefault: stage.isDefault,
    ...(stage.deploymentRegion
      ? { deploymentRegion: stage.deploymentRegion }
      : {}),
    agentCount: agents.length,
    variableCount: variables.length,
    updatedAt: stage.updatedAt,
  };
}
