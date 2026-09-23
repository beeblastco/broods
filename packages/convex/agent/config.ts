/**
 * Agent config CRUD for the canvas UI. Scoped to authenticated user.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { CanvasNode } from "../canvas";
import { toNestedAgentConfig } from "../model/agentConfigCodec";
import {
  assertAgentRuntimeRefs,
  mergeCanvasSandboxes,
} from "../model/agentRules";
import {
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
  syncAgentRowFields,
} from "../model/agentSync";
import { authKit } from "../auth";
import {
  accountIdForProject,
  auditDetailsJson,
  dashboardAuditActor,
  insertConfigAuditEvent,
  type ConfigAuditActor,
} from "../model/auditEvents";
import { getOwnedStage } from "../model/ownership/stage";
import { getProjectForRole } from "../model/ownership/project";
import { saveAgentRuntimeSecrets } from "../model/agentRuntimeSecrets";
import { redactConfigSecrets } from "../model/configValues";
import { ACCOUNT_MODEL_PROVIDER_NAMES } from "../model/modelProviders";
import { agentConfigsFields } from "../schema";

const MASKED_RUNTIME_VARIABLE_VALUE = "";

const agentConfigDoc = v.object({
  ...agentConfigsFields,
  _id: v.id("agentConfigs"),
  _creationTime: v.number(),
});

const agentProviderValidator = v.union(
  ...ACCOUNT_MODEL_PROVIDER_NAMES.map((name) => v.literal(name)),
);

const workspaceRefValidator = v.object({
  name: v.string(),
  workspaceId: v.string(),
  sandbox: v.optional(v.union(v.string(), v.null())),
});

const AGENT_ADMIN_REQUIRED =
  "Agent configuration can only be changed by an org admin.";

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    name: v.string(),
    provider: v.optional(agentProviderValidator),
    modelId: v.optional(v.string()),
    customBaseUrl: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    position: v.optional(v.object({ x: v.number(), y: v.number() })),
  },
  returns: v.id("agentConfigs"),
  handler: async (ctx, args): Promise<Id<"agentConfigs">> => {
    const {
      projectId,
      stageId,
      name,
      provider,
      modelId,
      customBaseUrl,
      description,
      systemPrompt,
      position,
    } = args;

    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) throw new Error(AGENT_ADMIN_REQUIRED);

    const stage = await getOwnedStage(ctx, authUser.id, stageId, "admin");
    if (!stage || stage.projectId !== projectId) {
      throw new Error("Stage not found.");
    }

    const now = Date.now();
    const trimmedName = name.trim();
    if (provider === "custom" && !customBaseUrl?.trim()) {
      throw new Error("customBaseUrl is required for the custom provider");
    }
    const configId = await ctx.db.insert("agentConfigs", {
      authId: authUser.id,
      name: trimmedName,
      description: description?.trim() || undefined,
      agentId: undefined,
      projectId: projectId,
      stageId: stageId,
      provider: provider,
      modelId: modelId?.trim() || "gpt-4.1-mini",
      systemPrompt: systemPrompt?.trim() || undefined,
      ...(provider === "custom" && customBaseUrl?.trim()
        ? {
            extraConfig: {
              provider: {
                custom: {
                  base_url: customBaseUrl.trim(),
                  baseURL: customBaseUrl.trim(),
                },
              },
            },
          }
        : {}),
      memoryToolEnabled: true,
      searchToolEnabled: false,
      updatedAt: now,
    });

    await ctx.db.patch(projectId, { updatedAt: now });

    if (position) {
      const layout = await ctx.db
        .query("canvasLayouts")
        .withIndex("by_projectId_and_stageId", (q) =>
          q.eq("projectId", projectId).eq("stageId", stageId),
        )
        .unique();

      const nextNode = {
        id: String(now),
        type: "agent" as const,
        position: position,
        data: {
          label: trimmedName,
          status: "idle" as const,
          agentConfigId: configId,
        },
      };

      if (layout) {
        await ctx.db.patch(layout._id, {
          nodes: [...layout.nodes, nextNode],
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("canvasLayouts", {
          authId: authUser.id,
          projectId: projectId,
          stageId: stageId,
          nodes: [nextNode],
          edges: [],
          updatedAt: now,
        });
      }
    }

    // Provision the broods agents row so the harness can resolve
    // this config by its public agentId. No-ops if the org isn't yet
    // provisioned with a broods account.
    const accountId = await accountIdForProject(ctx, projectId);
    if (accountId) {
      await ensureAgentsRowForConfig(ctx, configId, authUser.id, accountId);
      await pushEncryptedConfigToAgentRow(ctx, configId, accountId);
    }
    const created = await ctx.db.get(configId);
    await recordAgentConfigAudit(ctx, dashboardAuditActor(authUser), {
      projectId: projectId,
      stageId: stageId,
      action: "created",
      agentId: created?.agentId,
      configId: configId,
      name: trimmedName,
      summary: "Agent configuration created",
      details: { configId: configId },
    });

    return configId;
  },
});

export const getById = query({
  args: { configId: v.id("agentConfigs") },
  returns: v.union(v.null(), agentConfigDoc),
  handler: async (ctx, { configId }): Promise<Doc<"agentConfigs"> | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const config = await ctx.db.get(configId);
    if (!config || !(await canAccessAgentConfig(ctx, authUser.id, config)))
      return null;
    const masked = maskRuntimeVariables(config);
    if (await getProjectForRole(ctx, authUser.id, config.projectId, "admin")) {
      return masked;
    }

    // extraConfig holds the literal channel tokens and webhook secrets the
    // dashboard writes. Members read them masked; only admins save the config
    // back, so a mask never overwrites a stored secret.
    return redactConfigSecrets(masked);
  },
});

export const remove = mutation({
  args: { configId: v.id("agentConfigs") },
  returns: v.id("agentConfigs"),
  handler: async (ctx, { configId }): Promise<Id<"agentConfigs">> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const existing = await ctx.db.get(configId);
    if (
      !existing ||
      !(await canAccessAgentConfig(ctx, authUser.id, existing))
    ) {
      throw new Error("Agent config not found.");
    }
    await assertAgentConfigAdmin(ctx, authUser.id, existing);

    // Code is the source of truth for CLI-managed agents: the dashboard may
    // edit them (changes are overwritten on the next sync) but must not delete
    // them. Removal happens by deleting them from `broods/` and running
    // `broods deploy --prune`.
    if (existing.managedBy === "cli") {
      throw new Error(
        "This agent is managed by code. Remove it from your project and run `broods deploy --prune` to delete it.",
      );
    }

    // Note: the stage's runtime API key is shared across all its agents
    // (stage-scoped), so deleting one agent config must NOT delete it. The key
    // is only removed when the whole stage is deleted (see stage.ts).

    // Clean up the linked broods `agents` row if present so the
    // harness side stays consistent with the dashboard's canvas. A row under
    // another account is never this config's to delete.
    const accountId = await accountIdForProject(ctx, existing.projectId);
    const normalized = existing.agentId
      ? ctx.db.normalizeId("agents", existing.agentId)
      : null;
    const agent = normalized ? await ctx.db.get(normalized) : null;
    const foreignAgent = agent !== null && agent.accountId !== accountId;
    if (agent && !foreignAgent) {
      await ctx.db.delete(agent._id);
      // Its conversations, queued work and status rows are keyed by agent
      // and nothing else would ever collect them. Batches continue on their
      // own, so this is scheduled rather than awaited to completion.
      await ctx.scheduler.runAfter(0, internal.runtime.deleteAgentRuntimeData, {
        accountId: agent.accountId,
        agentId: agent._id,
      });
    }

    await recordAgentConfigAudit(ctx, dashboardAuditActor(authUser), {
      projectId: existing.projectId,
      stageId: existing.stageId,
      action: "deleted",
      agentId: foreignAgent ? undefined : existing.agentId,
      configId: configId,
      name: existing.name,
      summary: "Agent configuration deleted",
      details: {
        configId: configId,
        ...(foreignAgent ? { foreignAgentRowSkipped: true } : {}),
      },
    });
    await ctx.db.delete(configId);

    return configId;
  },
});

export const update = mutation({
  args: {
    configId: v.id("agentConfigs"),
    name: v.optional(v.string()),
    provider: v.optional(agentProviderValidator),
    modelId: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
    maxTurns: v.optional(v.number()),
    allowedTools: v.optional(v.array(v.string())),
    permissionMode: v.optional(v.string()),
    outputFormat: v.optional(v.any()),
    providerOptions: v.optional(v.any()),
    temperature: v.optional(v.number()),
    maxTokens: v.optional(v.number()),
    memoryToolEnabled: v.optional(v.boolean()),
    searchToolEnabled: v.optional(v.boolean()),
    searchToolConfig: v.optional(v.any()),
    runtimeVariables: v.optional(
      v.array(v.object({ key: v.string(), value: v.string() })),
    ),
    extraConfig: v.optional(v.any()),
  },
  returns: v.id("agentConfigs"),
  handler: async (ctx, args): Promise<Id<"agentConfigs">> => {
    const { configId, ...updates } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const existing = await ctx.db.get(configId);
    if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
      throw new Error("Agent config not found.");
    }
    await assertAgentConfigAdmin(ctx, user.id, existing);

    const patch = Object.fromEntries(
      Object.entries(updates)
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) => [
          key,
          key === "outputFormat" && value === null ? undefined : value,
        ]),
    );
    if (Array.isArray(patch.runtimeVariables)) {
      patch.runtimeVariables = await saveAgentRuntimeSecrets(
        ctx,
        configId,
        patch.runtimeVariables as Array<{ key: string; value: string }>,
      );
    }

    await ctx.db.patch(configId, { ...patch, updatedAt: Date.now() });

    // Keep the broods `agents` row aligned; this also provisions
    // the runtime row when an org account was created after the config.
    const accountId = await accountIdForProject(ctx, existing.projectId);
    if (accountId) {
      await ensureAgentsRowForConfig(ctx, configId, user.id, accountId);
      await syncAgentRowFields(ctx, configId, accountId, {
        name: updates.name,
        description: updates.description,
      });
      await pushEncryptedConfigToAgentRow(ctx, configId, accountId);
    }
    const updated = await ctx.db.get(configId);
    const agentRowRelinked =
      existing.agentId !== undefined && updated?.agentId !== existing.agentId;
    await recordAgentConfigAudit(ctx, dashboardAuditActor(user), {
      projectId: existing.projectId,
      stageId: existing.stageId,
      action: "updated",
      agentId: updated?.agentId,
      configId: configId,
      name: updated?.name ?? existing.name,
      summary: "Agent configuration updated",
      details: {
        configId: configId,
        changedFields: Object.keys(patch).sort(),
        ...(agentRowRelinked ? { agentRowRelinked: true } : {}),
      },
    });

    return configId;
  },
});

/**
 * Updates the broods runtime resource references derived from the canvas graph.
 * This preserves unrelated extraConfig branches while replacing the sandbox
 * list (in canvas order) and the workspaces.
 */
export const updateRuntimeRefs = mutation({
  args: {
    configId: v.id("agentConfigs"),
    sandboxes: v.array(v.string()),
    workspaces: v.union(v.array(workspaceRefValidator), v.null()),
  },
  returns: v.id("agentConfigs"),
  handler: async (ctx, args): Promise<Id<"agentConfigs">> => {
    const { configId, sandboxes: canvasSandboxes, workspaces } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const existing = await ctx.db.get(configId);
    if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
      throw new Error("Agent config not found.");
    }
    await assertAgentConfigAdmin(ctx, user.id, existing);

    // Code-managed agents get their wiring from their owner (CLI deploy or
    // account API); canvas-derived refs must not overwrite it. Before the
    // API wiring was drawn on the canvas, a save on a layout holding a bare
    // API agent node derived "no refs" here and stripped the live config.
    if (existing.managedBy === "cli" || existing.managedBy === "api") {
      return configId;
    }

    // Sandboxes with no node on this stage's canvas were never on screen to
    // remove, so they stay listed after the ones the canvas draws.
    const layout = await ctx.db
      .query("canvasLayouts")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", existing.projectId).eq("stageId", existing.stageId),
      )
      .unique();
    const canvasSandboxIds = new Set(
      ((layout?.nodes ?? []) as CanvasNode[]).flatMap((node) =>
        node.type === "sandbox" && typeof node.data.resourceId === "string"
          ? [node.data.resourceId]
          : [],
      ),
    );
    const extraConfig = { ...asRecord(existing.extraConfig) };
    const sandboxes = mergeCanvasSandboxes(
      canvasSandboxes,
      await liveStoredSandboxes(ctx, extraConfig.sandboxes, canvasSandboxIds),
      canvasSandboxIds,
    );
    if (sandboxes.length > 0) {
      extraConfig.sandboxes = sandboxes;
    } else {
      delete extraConfig.sandboxes;
    }
    if (workspaces && workspaces.length > 0) {
      extraConfig.workspaces = workspaces;
    } else {
      delete extraConfig.workspaces;
    }
    // Old nested AgentWorkspaceConfig and the single default `sandbox` are no
    // longer part of broods's runtime contract.
    delete extraConfig.sandbox;
    delete extraConfig.workspace;

    // Provisioning stays unconditional. A canvas save is where an agent whose
    // org gained an account after the config was made first gets its row.
    // A replaced foreign link counts as provisioned too.
    const accountId = await accountIdForProject(ctx, existing.projectId);
    const agentRowId = accountId
      ? await ensureAgentsRowForConfig(ctx, configId, user.id, accountId)
      : null;
    const provisionedNow =
      agentRowId !== null && agentRowId !== existing.agentId;

    // Skip the patch and encryption push when nothing changed. Every canvas
    // save derives refs for all agents, so most calls land here. A row created
    // just above still needs the push, or it stays empty until the next edit.
    if (
      !provisionedNow &&
      JSON.stringify(extraConfig) ===
        JSON.stringify(asRecord(existing.extraConfig))
    ) {
      return configId;
    }

    // A drawn edge can still name refs the config API refuses, like a
    // workspace mounted on a later sandbox. Refuse them here, not at run time.
    assertAgentRuntimeRefs(
      toNestedAgentConfig({ ...existing, extraConfig: extraConfig }),
    );
    await ctx.db.patch(configId, {
      extraConfig: extraConfig,
      updatedAt: Date.now(),
    });
    if (accountId) {
      await pushEncryptedConfigToAgentRow(ctx, configId, accountId);
    }

    return configId;
  },
});

/**
 * Updates the broods `subagent.allowed` branch for one caller agent from the
 * canvas's agent→agent edges. Resolves each callee config's linked `agentId`
 * (provisioning its `agents` row when missing) into the allow-list, enabling
 * subagent calls when non-empty and clearing the branch when empty.
 */
export const updateSubagentRefs = mutation({
  args: {
    configId: v.id("agentConfigs"),
    calleeConfigIds: v.array(v.id("agentConfigs")),
  },
  returns: v.id("agentConfigs"),
  handler: async (ctx, args): Promise<Id<"agentConfigs">> => {
    const { configId, calleeConfigIds } = args;

    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const existing = await ctx.db.get(configId);
    if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
      throw new Error("Agent config not found.");
    }
    await assertAgentConfigAdmin(ctx, user.id, existing);

    // Code-managed agents own their subagent allow-list; see updateRuntimeRefs.
    if (existing.managedBy === "cli" || existing.managedBy === "api") {
      return configId;
    }

    // Map each callee config to its broods agents-row id, skipping
    // self-calls, configs outside this project (it can belong to another
    // account) and any config the caller can't provision.
    const accountId = await accountIdForProject(ctx, existing.projectId);
    const allowed: string[] = [];
    for (const calleeId of calleeConfigIds) {
      if (!accountId || calleeId === configId) continue;
      const callee = await ctx.db.get(calleeId);
      if (!callee || callee.projectId !== existing.projectId) continue;
      const agentRowId = await ensureAgentsRowForConfig(
        ctx,
        calleeId,
        user.id,
        accountId,
      );
      if (agentRowId) allowed.push(agentRowId);
    }
    allowed.sort();

    const extraConfig = { ...asRecord(existing.extraConfig) };
    const prevSubagent = asRecord(extraConfig.subagent);
    // Preserve any context/mode the caller already set; only swap enabled+allowed.
    const nextSubagent =
      allowed.length > 0
        ? { ...prevSubagent, enabled: true, allowed: allowed }
        : undefined;

    if (
      JSON.stringify(extraConfig.subagent ?? null) ===
      JSON.stringify(nextSubagent ?? null)
    ) {
      return configId;
    }

    if (nextSubagent) {
      extraConfig.subagent = nextSubagent;
    } else {
      delete extraConfig.subagent;
    }

    await ctx.db.patch(configId, {
      extraConfig: extraConfig,
      updatedAt: Date.now(),
    });

    if (accountId) {
      await ensureAgentsRowForConfig(ctx, configId, user.id, accountId);
      await pushEncryptedConfigToAgentRow(ctx, configId, accountId);
    }

    return configId;
  },
});

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Members read agent configs; every write needs the org admin role. */
async function assertAgentConfigAdmin(
  ctx: Parameters<typeof getProjectForRole>[0],
  authId: string,
  config: { projectId: Id<"projects"> },
): Promise<void> {
  if (!(await getProjectForRole(ctx, authId, config.projectId, "admin"))) {
    throw new Error(AGENT_ADMIN_REQUIRED);
  }
}

/** Returns true when the caller may read a project-scoped agent config. */
async function canAccessAgentConfig(
  ctx: Parameters<typeof getProjectForRole>[0],
  authId: string,
  config: { projectId: Id<"projects"> },
): Promise<boolean> {
  return Boolean(await getProjectForRole(ctx, authId, config.projectId));
}

/**
 * Stored sandbox ids still worth keeping: those on the canvas, and those whose
 * row still exists. A node deleted on the canvas leaves the layout too, and
 * the layout save already deleted its dashboard row, so it must not linger.
 */
async function liveStoredSandboxes(
  ctx: MutationCtx,
  stored: unknown,
  canvasSandboxIds: ReadonlySet<string>,
): Promise<string[]> {
  const live: string[] = [];
  for (const id of Array.isArray(stored) ? stored : []) {
    if (typeof id !== "string") continue;
    const rowId = ctx.db.normalizeId("sandboxConfigs", id);
    if (canvasSandboxIds.has(id) || (rowId && (await ctx.db.get(rowId)))) {
      live.push(id);
    }
  }

  return live;
}

/** Hide secret values from browser reads while preserving variable names. */
function maskRuntimeVariables<
  T extends { runtimeVariables?: Array<{ key: string; value: string }> },
>(config: T): T {
  return {
    ...config,
    runtimeVariables: config.runtimeVariables?.map((entry) => ({
      key: entry.key,
      value: MASKED_RUNTIME_VARIABLE_VALUE,
    })),
  };
}

/**
 * Record a dashboard agent config mutation when the project has a provisioned account.
 */
async function recordAgentConfigAudit(
  ctx: MutationCtx,
  actor: ConfigAuditActor,
  input: {
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    action: string;
    agentId?: string;
    configId: Id<"agentConfigs">;
    name?: string;
    summary: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  const accountId = await accountIdForProject(ctx, input.projectId);
  if (!accountId) return;

  await insertConfigAuditEvent(ctx.db, {
    accountId: accountId,
    projectId: input.projectId,
    stageId: input.stageId,
    actor: actor,
    action: input.action,
    resource: {
      kind: "agent",
      id: input.agentId ?? input.configId,
      name: input.name,
    },
    summary: input.summary,
    detailsJson: input.details ? auditDetailsJson(input.details) : undefined,
  });
}
