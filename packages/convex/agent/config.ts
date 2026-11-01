import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { mutation, query, type MutationCtx } from "../_generated/server";
import type { CanvasNode } from "../model/canvasShapes";
import {
  agentCanvasBadge,
  collectEnvPlaceholderNames,
  toNestedAgentConfig,
  type AgentCanvasBadge,
} from "../model/agentConfigCodec";
import {
  assertAgentRuntimeRefs,
  mergeCanvasSandboxes,
} from "../model/agentRules";
import {
  deleteAgentRow,
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
  syncAgentRowFields,
} from "../model/agentSync";
import { authKit } from "../auth";
import {
  accountIdForProject,
  auditDetailsJson,
  dashboardAuditActor,
  appendAuditEvent,
  type AuditActor,
} from "../model/auditEvents";
import { getOwnedStage, getProjectStage } from "../model/ownership/stage";
import {
  getProjectForRole,
  getProjectForWrite,
} from "../model/ownership/project";
import {
  deleteAgentConfig,
  saveAgentRuntimeSecrets,
} from "../model/agentRuntimeSecrets";
import { redactConfigSecrets } from "../model/configValues";
import { loadEnvironmentVariableValues } from "../model/environmentValues";
import {
  ACCOUNT_MODEL_PROVIDER_NAMES,
  providerApiKeyEnvName,
  type AccountModelProviderName,
} from "../model/modelProviders";
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

const agentCanvasBadgeValidator = v.object({
  publicAccess: v.boolean(),
  skills: v.array(v.string()),
  structuredOutput: v.boolean(),
});

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

    const project = await getProjectForWrite(
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
    const baseUrl = customBaseUrl?.trim();
    if (provider === "custom" && !baseUrl) {
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
      ...(provider
        ? {
            extraConfig: {
              provider: { [provider]: newProviderSettings(provider, baseUrl) },
            },
          }
        : {}),
      memoryToolEnabled: true,
      searchToolEnabled: false,
      updatedAt: now,
    });
    await bindStageEnvRefs(ctx, configId);

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

    // Only admins save the config back, so a member's mask never overwrites a stored secret.
    return redactConfigSecrets(masked);
  },
});

// One subscription per canvas; no badge field carries a secret a member must not read.
export const canvasBadges = query({
  args: {
    projectId: v.id("projects"),
    stageId: v.optional(v.id("stages")),
  },
  returns: v.record(v.id("agentConfigs"), agentCanvasBadgeValidator),
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<Record<Id<"agentConfigs">, AgentCanvasBadge>> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Empty, not a throw: a subscriber still holding a deleted stage must not crash.
    const stage = await getProjectStage(ctx, authUser.id, projectId, stageId);
    if (!stage) return {};

    const configs = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectId).eq("stageId", stage._id),
      )
      .collect();

    return Object.fromEntries(
      configs.map((config) => [config._id, agentCanvasBadge(config)]),
    );
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

    // Dashboard edits to code-managed agents are overwritten on sync; deletes are refused.
    if (existing.managedBy === "cli") {
      throw new Error(
        "This agent is managed by code. Remove it from your project and run `broods deploy --prune` to delete it.",
      );
    }

    // The runtime key is stage-scoped: it goes with the stage, never with one agent.
    const accountId = await accountIdForProject(ctx, existing.projectId);
    const normalized = existing.agentId
      ? ctx.db.normalizeId("agents", existing.agentId)
      : null;
    const agent = normalized ? await ctx.db.get(normalized) : null;
    const foreignAgent = agent !== null && agent.accountId !== accountId;
    if (agent && !foreignAgent) await deleteAgentRow(ctx, agent);

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
    await deleteAgentConfig(ctx, configId);

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
    if (updates.runtimeVariables === undefined) {
      await bindStageEnvRefs(ctx, configId);
    }

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

export const updateRuntimeRefs = mutation({
  args: {
    configId: v.id("agentConfigs"),
    sandboxes: v.array(v.string()),
    workspaces: v.union(v.array(workspaceRefValidator), v.null()),
  },
  returns: v.id("agentConfigs"),
  handler: async (ctx, args): Promise<Id<"agentConfigs">> => {
    const { configId, sandboxes: canvasSandboxes, workspaces } = args;

    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const existing = await ctx.db.get(configId);
    if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
      throw new Error("Agent config not found.");
    }
    await assertAgentConfigAdmin(ctx, user.id, existing);

    // Code-managed agents get their wiring from their owner, never from the canvas.
    if (existing.managedBy === "cli" || existing.managedBy === "api") {
      return configId;
    }

    // Sandboxes this canvas never drew were never on screen to remove, so they stay.
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
    // Retired keys, no longer in the runtime contract.
    delete extraConfig.sandbox;
    delete extraConfig.workspace;

    // Unconditional: a canvas save is where an agent whose org gained an account gets its row.
    const accountId = await accountIdForProject(ctx, existing.projectId);
    const agentRowId = accountId
      ? await ensureAgentsRowForConfig(ctx, configId, user.id, accountId)
      : null;
    const provisionedNow =
      agentRowId !== null && agentRowId !== existing.agentId;

    // Most saves change nothing, but a row provisioned just above still needs the push.
    if (
      !provisionedNow &&
      JSON.stringify(extraConfig) ===
        JSON.stringify(asRecord(existing.extraConfig))
    ) {
      return configId;
    }

    // A drawn edge can name refs the config API refuses: reject them now, not at run time.
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

export const updateSubagentRefs = mutation({
  args: {
    configId: v.id("agentConfigs"),
    calleeConfigIds: v.array(v.id("agentConfigs")),
  },
  returns: v.id("agentConfigs"),
  handler: async (ctx, args): Promise<Id<"agentConfigs">> => {
    const { configId, calleeConfigIds } = args;

    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const existing = await ctx.db.get(configId);
    if (!existing || !(await canAccessAgentConfig(ctx, user.id, existing))) {
      throw new Error("Agent config not found.");
    }
    await assertAgentConfigAdmin(ctx, user.id, existing);

    if (existing.managedBy === "cli" || existing.managedBy === "api") {
      return configId;
    }

    // A config outside this project can belong to another account.
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

export const userTokenRequirement = query({
  args: { configId: v.id("agentConfigs") },
  returns: v.union(v.boolean(), v.null()),
  handler: async (ctx, { configId }): Promise<boolean | null> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const config = await ctx.db.get(configId);
    if (!config || !(await canAccessAgentConfig(ctx, user.id, config))) {
      return null;
    }
    const agent = await linkedAgentRow(ctx, config);

    return agent ? agent.requireUserToken === true : null;
  },
});

// Allowed on code-managed agents: a security switch on the agent row, not synced config.
export const setRequireUserToken = mutation({
  args: { configId: v.id("agentConfigs"), required: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { configId, required }): Promise<null> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const config = await ctx.db.get(configId);
    if (!config || !(await canAccessAgentConfig(ctx, user.id, config))) {
      throw new Error("Agent config not found.");
    }
    await assertAgentConfigAdmin(ctx, user.id, config);
    const agent = await linkedAgentRow(ctx, config);
    if (!agent) throw new Error("Deploy the agent first.");
    if (agent.requireUserToken === required) return null;

    await ctx.db.patch(agent._id, {
      requireUserToken: required,
      updatedAt: Date.now(),
    });
    await recordAgentConfigAudit(ctx, dashboardAuditActor(user), {
      projectId: config.projectId,
      stageId: config.stageId,
      action: required ? "user-token-required" : "user-token-optional",
      agentId: agent._id,
      configId: configId,
      name: config.name,
      summary: required
        ? "Runtime key requests now need a signed user token"
        : "Runtime key requests no longer need a signed user token",
    });

    return null;
  },
});

async function linkedAgentRow(
  ctx: Parameters<typeof getProjectForRole>[0],
  config: Doc<"agentConfigs">,
): Promise<Doc<"agents"> | null> {
  const agentId = config.agentId
    ? ctx.db.normalizeId("agents", config.agentId)
    : null;
  const agent = agentId ? await ctx.db.get(agentId) : null;
  if (!agent) return null;

  return agent.accountId === (await accountIdForProject(ctx, config.projectId))
    ? agent
    : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function assertAgentConfigAdmin(
  ctx: Parameters<typeof getProjectForRole>[0],
  authId: string,
  config: { projectId: Id<"projects"> },
): Promise<void> {
  if (!(await getProjectForWrite(ctx, authId, config.projectId, "admin"))) {
    throw new Error(AGENT_ADMIN_REQUIRED);
  }
}

// As a CLI sync does, so setting the stage variable later re-resolves the agent. A name
// the stage lacks keeps the agent's earlier value, else empty.
async function bindStageEnvRefs(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
): Promise<void> {
  const config = await ctx.db.get(configId);
  if (!config) return;
  const names = [...collectEnvPlaceholderNames(config)].sort();
  if (names.length === 0 && !config.runtimeVariables?.length) return;

  const values = await loadEnvironmentVariableValues(
    ctx,
    config.projectId,
    config.stageId,
    names,
  );
  const runtimeVariables = await saveAgentRuntimeSecrets(
    ctx,
    configId,
    names.map((name) => ({
      key: name,
      value: values[name] ?? MASKED_RUNTIME_VARIABLE_VALUE,
    })),
  );
  await ctx.db.patch(configId, { runtimeVariables: runtimeVariables });
}

async function canAccessAgentConfig(
  ctx: Parameters<typeof getProjectForRole>[0],
  authId: string,
  config: { projectId: Id<"projects"> },
): Promise<boolean> {
  return Boolean(await getProjectForRole(ctx, authId, config.projectId));
}

// A sandbox deleted on the canvas already lost its row, so it must not linger here.
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

function newProviderSettings(
  provider: AccountModelProviderName,
  baseUrl: string | undefined,
): Record<string, string | undefined> {
  const keyVariable = providerApiKeyEnvName(provider);

  return {
    ...(keyVariable ? { apiKey: `\${${keyVariable}}` } : {}),
    ...(provider === "custom" ? { base_url: baseUrl, baseURL: baseUrl } : {}),
  };
}

async function recordAgentConfigAudit(
  ctx: MutationCtx,
  actor: AuditActor,
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

  await appendAuditEvent(ctx.db, {
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
