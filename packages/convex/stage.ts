/**
 * Public stage queries and mutations scoped to a project owner.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import {
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
} from "./model/agentSync";
import { getOwnedStage } from "./model/ownership/stage";
import { getProjectForRole } from "./model/ownership/project";
import { stagesFields } from "./schema";

const deploymentRegion = v.union(
  v.literal("ap-southeast-1"),
  v.literal("eu-west-1"),
  v.literal("us-east-1"),
);

const stageDoc = v.object({
  ...stagesFields,
  _id: v.id("stages"),
  _creationTime: v.number(),
});

type StageKind = "development" | "production" | "custom";

/** Infer semantic stage role for legacy rows that predate `kind`. */
export function stageKindForName(
  stage: Pick<Doc<"stages">, "name" | "kind">,
): StageKind {
  if (stage.kind) return stage.kind;
  const normalized = stage.name.trim().toLowerCase();
  if (normalized === "development") return "development";
  if (normalized === "production") return "production";

  return "custom";
}

/** Case-insensitive lookup by explicit kind or conventional stage name. */
function findStageByKind(
  stages: Doc<"stages">[],
  kind: StageKind,
): Doc<"stages"> | undefined {
  return stages.find((stage) => stageKindForName(stage) === kind);
}

/** Strip Convex system fields so a fetched doc can be re-inserted as a clone. */
function stripSystemFields<T extends object>(
  doc: T,
): Omit<T, "_id" | "_creationTime"> {
  const clone = { ...(doc as Record<string, unknown>) };
  delete clone._id;
  delete clone._creationTime;

  return clone as Omit<T, "_id" | "_creationTime">;
}

/** Coerce an unknown JSON-ish value into a mutable record. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Deep-copies every resource scoped to `sourceStageId` into `targetStageId`:
 * agent configs (each with a fresh broods `agents` row), the canvas layout
 * (remapping node references to the cloned configs), tool services, and env vars.
 * Subagent allow-lists are remapped onto the cloned agents so agent→agent calls stay
 * within the new stage.
 */
export async function duplicateStageContents(
  ctx: MutationCtx,
  authId: string,
  projectId: Id<"projects">,
  sourceStageId: Id<"stages">,
  targetStageId: Id<"stages">,
  now: number,
): Promise<void> {
  // 1. Clone custom tools first: agent configs key `extraConfig.tools` by tool
  // id, so the clones need the new ids before step 2 remaps them.
  const sourceCustomTools = await ctx.db
    .query("accountTools")
    .withIndex("by_stageId_and_status", (q) =>
      q.eq("stageId", sourceStageId).eq("status", "active"),
    )
    .collect();
  const toolIdMap = new Map<string, string>();
  for (const tool of sourceCustomTools) {
    const newToolId = await ctx.db.insert("accountTools", {
      ...stripSystemFields(tool),
      stageId: targetStageId,
      updatedAt: now,
    });
    toolIdMap.set(tool._id, newToolId);
  }

  // 2. Clone agent configs and provision their agents rows, tracking id remaps.
  const sourceConfigs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", sourceStageId),
    )
    .collect();

  const configIdMap = new Map<Id<"agentConfigs">, Id<"agentConfigs">>();
  const agentIdMap = new Map<string, string>();
  for (const source of sourceConfigs) {
    const newConfigId = await ctx.db.insert("agentConfigs", {
      ...stripSystemFields(source),
      stageId: targetStageId,
      agentId: undefined,
      updatedAt: now,
    });
    configIdMap.set(source._id, newConfigId);

    const newAgentId = await ensureAgentsRowForConfig(ctx, newConfigId, authId);
    if (source.agentId && newAgentId)
      agentIdMap.set(source.agentId, newAgentId);
  }

  // 3. Remap each clone's subagent allow-list and tool ids onto the cloned
  // resources, then push config.
  for (const newConfigId of configIdMap.values()) {
    const clone = await ctx.db.get(newConfigId);
    if (!clone) continue;

    const extraConfig = asRecord(clone.extraConfig);
    const nextExtra = { ...extraConfig };
    let changed = false;

    const subagent = asRecord(extraConfig.subagent);
    if (Array.isArray(subagent.allowed)) {
      const remapped = (subagent.allowed as string[])
        .map((agentId) => agentIdMap.get(agentId))
        .filter((agentId): agentId is string => !!agentId);
      if (remapped.length > 0) {
        nextExtra.subagent = { ...subagent, allowed: remapped, enabled: true };
      } else {
        delete nextExtra.subagent;
      }
      changed = true;
    }

    // Keys the map doesn't know are provider tools (`googleSearch`), so they stay.
    const tools = asRecord(extraConfig.tools);
    if (Object.keys(tools).length > 0 && toolIdMap.size > 0) {
      nextExtra.tools = Object.fromEntries(
        Object.entries(tools).map(([key, value]) => [
          toolIdMap.get(key) ?? key,
          value,
        ]),
      );
      changed = true;
    }

    if (changed) {
      await ctx.db.patch(newConfigId, {
        extraConfig: nextExtra,
        updatedAt: now,
      });
    }

    await pushEncryptedConfigToAgentRow(ctx, newConfigId);
  }

  // 4. Clone the canvas layout, repointing agent and tool nodes at the clones.
  const sourceLayout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", sourceStageId),
    )
    .unique();
  if (sourceLayout) {
    const remappedNodes = (
      sourceLayout.nodes as Array<Record<string, unknown>>
    ).map((node) => {
      const data = asRecord(node.data);
      const oldConfigId = data.agentConfigId as Id<"agentConfigs"> | undefined;
      const newConfigId = oldConfigId
        ? configIdMap.get(oldConfigId)
        : undefined;
      if (newConfigId)
        return { ...node, data: { ...data, agentConfigId: newConfigId } };

      // Tool nodes point at their row through `resourceId`.
      const newToolId =
        typeof data.resourceId === "string"
          ? toolIdMap.get(data.resourceId)
          : undefined;

      return newToolId
        ? { ...node, data: { ...data, resourceId: newToolId } }
        : node;
    });
    await ctx.db.insert("canvasLayouts", {
      authId: authId,
      projectId: projectId,
      stageId: targetStageId,
      nodes: remappedNodes,
      edges: sourceLayout.edges,
      updatedAt: now,
    });
  }

  // 5. Clone environment variables.
  const sourceVars = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", sourceStageId),
    )
    .collect();
  for (const variable of sourceVars) {
    await ctx.db.insert("environmentVariables", {
      ...stripSystemFields(variable),
      stageId: targetStageId,
      updatedAt: now,
    });
  }
}

/**
 * Cascade-deletes every resource scoped to a stage: agent configs (plus their
 * deployments and linked broods `agents` rows), the canvas layout, tool
 * services, env vars, and deploy keys.
 */
export async function deleteStageContents(
  ctx: MutationCtx,
  stage: Doc<"stages">,
): Promise<void> {
  const { projectId, _id: stageId } = stage;

  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const config of configs) {
    if (config.agentId) {
      const normalized = ctx.db.normalizeId("agents", config.agentId);
      if (normalized) {
        const agent = await ctx.db.get(normalized);
        if (agent) await ctx.db.delete(normalized);
      }
    }

    // Runtime secrets are keyed to the agent config, so they orphan unless
    // deleted alongside it.
    const runtimeSecrets = await ctx.db
      .query("agentRuntimeSecrets")
      .withIndex("by_agentConfigId", (q) => q.eq("agentConfigId", config._id))
      .collect();
    for (const secret of runtimeSecrets) await ctx.db.delete(secret._id);

    await ctx.db.delete(config._id);
  }

  // The stage's runtime API key is scoped to (project, stage), not
  // to an agent config, so it must be deleted here or it would keep
  // authenticating requests against a deleted stage.
  const stageDeployments = await ctx.db
    .query("agentDeployments")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const deployment of stageDeployments)
    await ctx.db.delete(deployment._id);

  const layouts = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const layout of layouts) await ctx.db.delete(layout._id);

  // Custom tools are stage-scoped resources, so they go with it. The S3
  // bundle is left to the account-level sweep; nothing else references it.
  const customTools = await ctx.db
    .query("accountTools")
    .withIndex("by_stageId_and_status", (q) => q.eq("stageId", stageId))
    .collect();
  for (const tool of customTools) await ctx.db.delete(tool._id);

  const variables = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const variable of variables) await ctx.db.delete(variable._id);

  const deployKeys = await ctx.db
    .query("deployKeys")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const deployKey of deployKeys) await ctx.db.delete(deployKey._id);

  // Audit rows for env-var reveals are scoped to the stage.
  const reveals = await ctx.db
    .query("environmentVariableReveals")
    .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
    .collect();
  for (const reveal of reveals) await ctx.db.delete(reveal._id);

  // The inbound-webhook lookup keys on (accountId, platform, externalId,
  // status) with no stageId, so a surviving record keeps routing messages into
  // the deleted stage and blocks `create` from rebinding that place.
  const channels = await ctx.db
    .query("channelRecords")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const channel of channels) await ctx.db.delete(channel._id);

  // The remaining stage-scoped config resources. `cliSync` prunes these by
  // stageId, so anything left behind is unreachable once the stage is gone.
  const policies = await ctx.db
    .query("agentPolicies")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const policy of policies) await ctx.db.delete(policy._id);

  const sandboxes = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const sandbox of sandboxes) await ctx.db.delete(sandbox._id);

  const workspaces = await ctx.db
    .query("workspaceConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const workspace of workspaces) {
    // Managed workspace files live outside Convex and must be purged before the
    // workspace row disappears. Bring-your-own buckets are customer-owned.
    if (!workspace.config?.storage?.bucket) {
      await ctx.scheduler.runAfter(0, internal.awsWorkspaceFiles.purge, {
        accountId: workspace.accountId,
        workspaceId: workspace._id,
      });
    }
    await ctx.db.delete(workspace._id);
  }

  const externals = await ctx.db
    .query("cliExternalResources")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const external of externals) await ctx.db.delete(external._id);
}

/** Returns true when a stage already has user/configuration content. */
async function hasStageContents(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<boolean> {
  const agentConfig = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .first();
  if (agentConfig) return true;

  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .first();
  if (layout) return true;

  // Tombstones do not count: a tombstone-only stage is still empty, and
  // treating it as occupied silently skips the clone into production.
  const tool = await ctx.db
    .query("accountTools")
    .withIndex("by_stageId_and_status", (q) =>
      q.eq("stageId", stageId).eq("status", "active"),
    )
    .first();
  if (tool) return true;

  const variable = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .first();

  return Boolean(variable);
}

/**
 * Stage listing for any org member. Split from the `list` query so the role
 * boundary is testable: convex-test cannot run the query itself, which needs
 * the WorkOS AuthKit component.
 */
export async function listStagesForProject(
  ctx: QueryCtx | MutationCtx,
  authId: string,
  projectId: Id<"projects">,
): Promise<Doc<"stages">[]> {
  // Return empty rather than throwing so a just-deleted project doesn't crash
  // reactive subscribers (header selector, settings) before they navigate away.
  const project = await getProjectForRole(ctx, authId, projectId);
  if (!project) return [];

  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .collect();

  return stages.sort((a, b) =>
    a.isDefault !== b.isDefault
      ? a.isDefault
        ? -1
        : 1
      : a.name.localeCompare(b.name),
  );
}

export const list = query({
  args: { projectId: v.id("projects") },
  returns: v.array(stageDoc),
  handler: async (ctx, { projectId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    return listStagesForProject(ctx, authUser.id, projectId);
  },
});

export const ensureDefault = mutation({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), v.id("stages")),
  handler: async (ctx, { projectId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // No-op when the project is gone: a just-deleted project briefly keeps the
    // header's "no stages → ensureDefault" effect firing, so return null
    // instead of throwing rather than resurrecting a stage.
    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) return null;

    const existing = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    const now = Date.now();
    const development = findStageByKind(existing, "development");

    // Legacy rows predating `kind` named "Production" were really the dev
    // workspace, so promote a lone one to Development. A row with an explicit
    // `kind` is an intentional choice and must never be renamed.
    const legacyProductionToPromote =
      !development &&
      existing.length === 1 &&
      existing[0]?.kind === undefined &&
      stageKindForName(existing[0]) === "production"
        ? existing[0]
        : undefined;
    if (legacyProductionToPromote) {
      await ctx.db.patch(legacyProductionToPromote._id, {
        name: "Development",
        kind: "development",
        deploymentRegion: undefined,
        isDefault: true,
        updatedAt: now,
      });
      await ctx.db.patch(projectId, { updatedAt: now });

      return legacyProductionToPromote._id;
    }

    // Otherwise guarantee a Development row that is the sole default, creating
    // one if needed and demoting any other stage that claims the default.
    let changed = !development;
    const developmentId =
      development?._id ??
      (await ctx.db.insert("stages", {
        authId: authUser.id,
        projectId: projectId,
        name: "Development",
        kind: "development",
        isDefault: true,
        updatedAt: now,
      }));

    for (const stage of existing) {
      const shouldBeDefault = stage._id === developmentId;
      const needsNameFix =
        shouldBeDefault &&
        (stage.kind !== "development" || stage.name !== "Development");
      if (stage.isDefault !== shouldBeDefault || needsNameFix) {
        await ctx.db.patch(stage._id, {
          ...(shouldBeDefault
            ? { name: "Development", kind: "development" as const }
            : {}),
          isDefault: shouldBeDefault,
          updatedAt: now,
        });
        changed = true;
      }
    }
    if (changed) await ctx.db.patch(projectId, { updatedAt: now });

    return developmentId;
  },
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    duplicateFromId: v.optional(v.id("stages")),
  },
  returns: v.id("stages"),
  handler: async (ctx, { projectId, name, duplicateFromId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) throw new Error("Project not found.");

    if (duplicateFromId) {
      const source = await getOwnedStage(ctx, authUser.id, duplicateFromId);
      if (!source || source.projectId !== projectId) {
        throw new Error("Source stage not found.");
      }
    }

    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Stage name is required.");

    const now = Date.now();
    const stageId = await ctx.db.insert("stages", {
      authId: authUser.id,
      projectId: projectId,
      name: trimmedName,
      kind: "custom",
      isDefault: false,
      updatedAt: now,
    });

    // Deep-copy the source stage's full architecture into the new one.
    if (duplicateFromId) {
      await duplicateStageContents(
        ctx,
        authUser.id,
        projectId,
        duplicateFromId,
        stageId,
        now,
      );
    }

    await ctx.db.patch(projectId, { updatedAt: now });

    return stageId;
  },
});

export const initializeProduction = mutation({
  args: {
    projectId: v.id("projects"),
    sourceStageId: v.id("stages"),
    deploymentRegion: deploymentRegion,
  },
  returns: v.id("stages"),
  handler: async (ctx, { projectId, sourceStageId, deploymentRegion }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) throw new Error("Project not found.");

    const source = await getOwnedStage(ctx, authUser.id, sourceStageId);
    if (!source || source.projectId !== projectId) {
      throw new Error("Source stage not found.");
    }

    const existing = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();
    const production = findStageByKind(existing, "production");
    const now = Date.now();
    const productionId =
      production?._id ??
      (await ctx.db.insert("stages", {
        authId: authUser.id,
        projectId: projectId,
        name: "Production",
        kind: "production",
        deploymentRegion: deploymentRegion,
        isDefault: false,
        updatedAt: now,
      }));

    const productionHasContents = production
      ? await hasStageContents(ctx, projectId, production._id)
      : false;
    if (!productionHasContents && productionId !== sourceStageId) {
      await duplicateStageContents(
        ctx,
        authUser.id,
        projectId,
        sourceStageId,
        productionId,
        now,
      );
    }

    await ctx.db.patch(productionId, {
      name: "Production",
      kind: "production",
      deploymentRegion: deploymentRegion,
      isDefault: false,
      updatedAt: now,
    });
    for (const stage of existing.filter(
      (entry) =>
        entry._id !== productionId &&
        entry.isDefault &&
        stageKindForName(entry) !== "development",
    )) {
      await ctx.db.patch(stage._id, { isDefault: false, updatedAt: now });
    }
    await ctx.db.patch(projectId, { updatedAt: now });

    return productionId;
  },
});

export const remove = mutation({
  args: { stageId: v.id("stages") },
  returns: v.id("stages"),
  handler: async (ctx, { stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage) throw new Error("Stage not found.");
    if (stage.isDefault)
      throw new Error("The default stage cannot be deleted.");
    const project = await getProjectForRole(
      ctx,
      authUser.id,
      stage.projectId,
      "admin",
    );
    if (!project) throw new Error("Stage not found.");

    // Cascade-delete every resource scoped to this stage before the row itself.
    await deleteStageContents(ctx, stage);

    await ctx.db.delete(stageId);
    await ctx.db.patch(stage.projectId, { updatedAt: Date.now() });

    return stageId;
  },
});
