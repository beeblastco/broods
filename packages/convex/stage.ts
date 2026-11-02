import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { readyStageDeployment } from "./agent/deployments";
import { authKit } from "./auth";
import {
  deleteAgentRow,
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
} from "./model/agentSync";
import { deleteAgentConfig } from "./model/agentRuntimeSecrets";
import { accountIdForProject } from "./model/auditEvents";
import { byDefaultThenName } from "./model/defaultStage";
import { assertStageName } from "./lib/slug";
import { getOwnedStage } from "./model/ownership/stage";
import {
  getProjectForRole,
  getProjectForWrite,
} from "./model/ownership/project";
import { agentsInStage, stageNameEquals } from "./model/projectScope";
import { deploymentRegionValidator, stagesFields } from "./schema";
import { LIVE_DEPLOYMENT_REGIONS } from "./cli/types";

const stageDoc = v.object({
  ...stagesFields,
  _id: v.id("stages"),
  _creationTime: v.number(),
});

// Copies agents, secrets and runtime wiring, so admin-only like deleting a stage.
const STAGE_ADMIN_REQUIRED =
  "Stages can only be created or promoted by an org admin.";

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    duplicateFromId: v.optional(v.id("stages")),
  },
  returns: v.id("stages"),
  handler: async (
    ctx,
    { projectId, name, duplicateFromId },
  ): Promise<Id<"stages">> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForWrite(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) throw new Error(STAGE_ADMIN_REQUIRED);

    if (duplicateFromId) {
      const source = await getOwnedStage(ctx, authUser.id, duplicateFromId);
      if (!source || source.projectId !== projectId) {
        throw new Error("Source stage not found.");
      }
    }

    const stageName = await assertCustomStageNameFree(ctx, projectId, name);

    const now = Date.now();
    const stageId = await ctx.db.insert("stages", {
      authId: authUser.id,
      projectId: projectId,
      name: stageName,
      kind: "custom",
      isDefault: false,
      updatedAt: now,
    });

    if (duplicateFromId) {
      await duplicateStageContents(
        ctx,
        authUser.id,
        projectId,
        duplicateFromId,
        stageId,
        now,
      );
    } else {
      // A clone gets no key: its agents' bot tokens would connect beside the source's.
      await readyStageDeployment(ctx, authUser, projectId, stageId);
    }

    await ctx.db.patch(projectId, { updatedAt: now });

    return stageId;
  },
});

export const ensureDefault = mutation({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), v.id("stages")),
  handler: async (ctx, { projectId }): Promise<Id<"stages"> | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Null, not a throw: a just-deleted project's header briefly still fires this.
    const project = await getProjectForRole(ctx, authUser.id, projectId);
    if (!project) return null;

    const existing = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();

    const now = Date.now();
    const development = existing.find((stage) => stage.kind === "development");
    if (!(await getProjectForWrite(ctx, authUser.id, projectId, "admin"))) {
      return development?._id ?? null;
    }

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
    if (!development) {
      await readyStageDeployment(ctx, authUser, projectId, developmentId);
    }
    if (changed) await ctx.db.patch(projectId, { updatedAt: now });

    return developmentId;
  },
});

export const initializeProduction = mutation({
  args: {
    projectId: v.id("projects"),
    sourceStageId: v.id("stages"),
    deploymentRegion: deploymentRegionValidator,
  },
  returns: v.id("stages"),
  handler: async (
    ctx,
    { projectId, sourceStageId, deploymentRegion },
  ): Promise<Id<"stages">> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForWrite(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) throw new Error(STAGE_ADMIN_REQUIRED);

    if (!LIVE_DEPLOYMENT_REGIONS.includes(deploymentRegion)) {
      throw new Error(`Region ${deploymentRegion} is not available yet.`);
    }
    const source = await getOwnedStage(ctx, authUser.id, sourceStageId);
    if (!source || source.projectId !== projectId) {
      throw new Error("Source stage not found.");
    }

    const existing = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();
    const production = existing.find((stage) => stage.kind === "production");
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
      // A region a deploy already pinned stays: data does not move.
      deploymentRegion: production?.deploymentRegion ?? deploymentRegion,
      isDefault: false,
      updatedAt: now,
    });
    for (const stage of existing.filter(
      (entry) =>
        entry._id !== productionId &&
        entry.isDefault &&
        entry.kind !== "development",
    )) {
      await ctx.db.patch(stage._id, { isDefault: false, updatedAt: now });
    }
    await ctx.db.patch(projectId, { updatedAt: now });

    return productionId;
  },
});

export const list = query({
  args: { projectId: v.id("projects") },
  returns: v.array(stageDoc),
  handler: async (ctx, { projectId }): Promise<Doc<"stages">[]> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    return listStagesForProject(ctx, authUser.id, projectId);
  },
});

export const remove = mutation({
  args: { stageId: v.id("stages") },
  returns: v.id("stages"),
  handler: async (ctx, { stageId }): Promise<Id<"stages">> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage) throw new Error("Stage not found.");
    if (stage.isDefault)
      throw new Error("The default stage cannot be deleted.");
    const project = await getProjectForWrite(
      ctx,
      authUser.id,
      stage.projectId,
      "admin",
    );
    if (!project) throw new Error("Stage not found.");

    await deleteStageContents(ctx, stage);

    await ctx.db.delete(stageId);
    await ctx.db.patch(stage.projectId, { updatedAt: Date.now() });

    return stageId;
  },
});

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
  // Two configs can name one agents row, so dedupe before deleting.
  const accountId = await accountIdForProject(ctx, projectId);
  const ownAgents = accountId
    ? await agentsInStage(
        ctx,
        { projectId: projectId, stageId: stageId },
        accountId,
      )
    : [];
  const unique = new Map(ownAgents.map((agent) => [agent._id, agent]));
  for (const agent of unique.values()) await deleteAgentRow(ctx, agent);

  for (const config of configs) await deleteAgentConfig(ctx, config._id);

  // The runtime key is per stage, not per config: left behind, it would still authenticate.
  const stageDeployments = await ctx.db
    .query("agentDeployments")
    .withIndex("by_projectId_and_stageId_and_status", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const deployment of stageDeployments)
    await ctx.db.delete(deployment._id);

  const syncs = await ctx.db
    .query("stageSyncs")
    .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
    .collect();
  for (const sync of syncs) await ctx.db.delete(sync._id);

  const layouts = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const layout of layouts) await ctx.db.delete(layout._id);

  const mcpRows = await ctx.db
    .query("mcp")
    .withIndex("by_stageId_and_status_and_name", (q) =>
      q.eq("stageId", stageId),
    )
    .collect();
  for (const server of mcpRows) await ctx.db.delete(server._id);

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

  const pinnedKeys = await ctx.db
    .query("accountApiKeys")
    .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
    .collect();
  for (const key of pinnedKeys) await ctx.db.delete(key._id);

  const reveals = await ctx.db
    .query("environmentVariableReveals")
    .withIndex("by_stageId", (q) => q.eq("stageId", stageId))
    .collect();
  for (const reveal of reveals) await ctx.db.delete(reveal._id);

  // The inbound-webhook lookup has no stageId, so a surviving record would route into the
  // deleted stage and block `create` from rebinding that place.
  const channels = await ctx.db
    .query("channelRecords")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const channel of channels) await ctx.db.delete(channel._id);

  const policies = await ctx.db
    .query("agentPolicies")
    .withIndex("by_stageId_and_status_and_name", (q) =>
      q.eq("stageId", stageId),
    )
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
    // Managed files live in our S3; bring-your-own buckets are the customer's to keep.
    if (!workspace.config?.storage?.bucket) {
      await ctx.scheduler.runAfter(0, internal.aws.workspaceFiles.purge, {
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

export async function duplicateStageContents(
  ctx: MutationCtx,
  authId: string,
  projectId: Id<"projects">,
  sourceStageId: Id<"stages">,
  targetStageId: Id<"stages">,
  now: number,
): Promise<void> {
  // MCP first: configs key `extraConfig.mcp` by row id, so the remap needs the new ids.
  const sourceMcpServers = await ctx.db
    .query("mcp")
    .withIndex("by_stageId_and_status_and_name", (q) =>
      q.eq("stageId", sourceStageId).eq("status", "active"),
    )
    .collect();
  const mcpIdMap = new Map<string, string>();
  for (const server of sourceMcpServers) {
    const newServerId = await ctx.db.insert("mcp", {
      ...stripSystemFields(server),
      stageId: targetStageId,
      updatedAt: now,
    });
    mcpIdMap.set(server._id, newServerId);
  }

  const sourceConfigs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", sourceStageId),
    )
    .collect();

  const accountId = await accountIdForProject(ctx, projectId);
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

    const newAgentId = accountId
      ? await ensureAgentsRowForConfig(ctx, newConfigId, authId, accountId)
      : null;
    if (source.agentId && newAgentId)
      agentIdMap.set(source.agentId, newAgentId);
  }

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

    const mcp = asRecord(extraConfig.mcp);
    if (Object.keys(mcp).length > 0 && mcpIdMap.size > 0) {
      nextExtra.mcp = Object.fromEntries(
        Object.entries(mcp).map(([key, value]) => [
          mcpIdMap.get(key) ?? key,
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

    if (accountId) {
      await pushEncryptedConfigToAgentRow(ctx, newConfigId, accountId);
    }
  }

  const sourceLayout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", sourceStageId),
    )
    .unique();
  if (sourceLayout) {
    const remappedNodes = sourceLayout.nodes.map((node) => {
      const data = asRecord(node.data);
      const oldConfigId = data.agentConfigId as Id<"agentConfigs"> | undefined;
      const newConfigId = oldConfigId
        ? configIdMap.get(oldConfigId)
        : undefined;
      if (newConfigId)
        return { ...node, data: { ...data, agentConfigId: newConfigId } };

      const newServerId =
        typeof data.resourceId === "string"
          ? mcpIdMap.get(data.resourceId)
          : undefined;

      return newServerId
        ? { ...node, data: { ...data, resourceId: newServerId } }
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

export function kindForStageName(name: string): Doc<"stages">["kind"] {
  const normalized = name.trim().toLowerCase();
  if (normalized === "development") return "development";
  if (normalized === "production") return "production";

  return "custom";
}

// Split from `list` for tests: convex-test cannot run AuthKit.
export async function listStagesForProject(
  ctx: QueryCtx | MutationCtx,
  authId: string,
  projectId: Id<"projects">,
): Promise<Doc<"stages">[]> {
  // Empty, not a throw: a just-deleted project must not crash reactive subscribers.
  const project = await getProjectForRole(ctx, authId, projectId);
  if (!project) return [];

  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .collect();

  return stages.sort(byDefaultThenName);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function assertCustomStageNameFree(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  name: string,
): Promise<string> {
  const stageName = assertStageName(name);
  if (kindForStageName(stageName) !== "custom") {
    throw new Error(
      "Development and Production are created by the project, not by name.",
    );
  }
  const siblings = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
    .collect();
  if (siblings.some((entry) => stageNameEquals(entry.name, stageName))) {
    throw new Error(`Stage ${stageName} already exists.`);
  }

  return stageName;
}

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

  const server = await ctx.db
    .query("mcp")
    .withIndex("by_stageId_and_status_and_name", (q) =>
      q.eq("stageId", stageId).eq("status", "active"),
    )
    .first();
  if (server) return true;

  const variable = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .first();

  return Boolean(variable);
}

function stripSystemFields<T extends object>(
  doc: T,
): Omit<T, "_id" | "_creationTime"> {
  const clone = { ...(doc as Record<string, unknown>) };
  delete clone._id;
  delete clone._creationTime;

  return clone as Omit<T, "_id" | "_creationTime">;
}
