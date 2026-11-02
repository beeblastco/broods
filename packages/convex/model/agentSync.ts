import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  fromNestedAgentConfig,
  substituteEnvPlaceholders,
  toNestedAgentConfig,
  type FlatPatch,
} from "./agentConfigCodec";
import {
  accountCipher,
  accountCipherForWrite,
  hasEncryptionSecret,
} from "./accountKeys";
import { uniqueProjectSlug } from "../lib/slug";
import {
  loadAgentRuntimeSecrets,
  saveAgentRuntimeSecrets,
} from "./agentRuntimeSecrets";
import { syncApiAgentCanvasWiring } from "./apiCanvasSync";
import { accountIdForProject } from "./auditEvents";
import { applyTidyLayout } from "./canvasLayout";
import { refreshAccountChannelEndpoints } from "./channelEndpoints";
import { redactConfigSecrets } from "./configValues";
import { deleteCron } from "./cronSchedules";
import { loadMcpServersByNode } from "./mcp";
import { stableJson } from "./objects";

// agentConfigs.projectId is the only link from the account plane to a project.
export async function backSyncCanvasFromAgentRow(
  ctx: MutationCtx,
  agentRowId: Id<"agents">,
): Promise<void> {
  const agent = await ctx.db.get(agentRowId);
  if (!agent) return;

  const existingConfig = await ctx.db
    .query("agentConfigs")
    .withIndex("by_agentId", (q) => q.eq("agentId", agentRowId))
    .first();
  if (existingConfig) return;

  const account = await ctx.db.get(agent.accountId);
  if (!account) return;

  const orgId = ctx.db.normalizeId("orgs", account.orgId);
  if (!orgId) return;

  const members = await ctx.db
    .query("orgMembers")
    .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", orgId))
    .collect();
  const membership =
    oldest(members.filter((member) => member.role === "owner")) ??
    oldest(members);
  if (!membership) return;

  const user = await ctx.db.get(membership.userId);
  if (!user) return;

  const { project, stage } = await ensureCanvasTarget(
    ctx,
    orgId,
    account,
    user.authId,
  );

  const flat = await decryptAgentFlatPatch(ctx, agent);

  const now = Date.now();
  const configId = await ctx.db.insert("agentConfigs", {
    authId: user.authId,
    name: agent.name,
    description: agent.description,
    agentId: agentRowId,
    projectId: project._id,
    stageId: stage._id,
    ...flatAgentConfigFields(flat),
    managedBy: "api",
    updatedAt: now,
  });

  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", project._id).eq("stageId", stage._id),
    )
    .unique();

  // Placeholder origin: the tidy pass places it; a lone first node belongs at the origin.
  const nextNode = {
    id: String(now),
    type: "agent" as const,
    position: { x: 0, y: 0 },
    data: {
      label: agent.name,
      status: "idle" as const,
      agentConfigId: configId,
      managedBy: "api" as const,
    },
  };

  if (layout) {
    await ctx.db.patch(layout._id, {
      nodes: applyTidyLayout(
        [...layout.nodes, nextNode],
        layout.edges,
        await loadMcpServersByNode(ctx, stage._id),
      ),
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("canvasLayouts", {
      authId: user.authId,
      projectId: project._id,
      stageId: stage._id,
      nodes: [nextNode],
      edges: [],
      updatedAt: now,
    });
  }

  await syncApiAgentCanvasWiring(ctx, {
    projectId: project._id,
    stageId: stage._id,
  });
}

// Every agent delete (dashboard, config API, CLI, stage) goes through here.
export async function deleteAgentRow(
  ctx: MutationCtx,
  agent: Doc<"agents">,
): Promise<void> {
  const crons = await ctx.db
    .query("crons")
    .withIndex("by_accountId_and_agentId", (q) =>
      q.eq("accountId", agent.accountId).eq("agentId", agent._id),
    )
    .collect();
  for (const cron of crons) await deleteCron(ctx, cron);
  await ctx.db.delete(agent._id);
  await ctx.scheduler.runAfter(0, internal.runtime.deleteAgentRuntimeData, {
    accountId: agent.accountId,
    agentId: agent._id,
  });
}

// accountId is the config's project account, never the caller's active org (another tenant).
export async function ensureAgentsRowForConfig(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
  authId: string,
  accountId: Id<"accounts">,
): Promise<Id<"agents"> | null> {
  const config = await ctx.db.get(configId);
  if (!config || config.authId !== authId) return null;

  if (config.agentId) {
    const normalized = ctx.db.normalizeId("agents", config.agentId);
    if (normalized) {
      const existing = await ctx.db.get(normalized);
      // A row under another account was mis-filed by an earlier sync: recreate, never reuse.
      if (existing?.accountId === accountId) return existing._id;
    }
  }

  const account = await ctx.db.get(accountId);
  if (!account) return null;

  const now = Date.now();
  const agentId = await ctx.db.insert("agents", {
    accountId: account._id,
    name: config.name,
    description: config.description,
    requireUserToken: true,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.patch(configId, { agentId: agentId, updatedAt: now });

  return agentId;
}

export async function mirrorAgentRowOntoConfig(
  ctx: MutationCtx,
  agentRowId: Id<"agents">,
): Promise<void> {
  const agent = await ctx.db.get(agentRowId);
  if (!agent) return;

  const linkedConfig = await ctx.db
    .query("agentConfigs")
    .withIndex("by_agentId", (q) => q.eq("agentId", agentRowId))
    .first();
  if (!linkedConfig) return;

  const flat = await decryptAgentFlatPatch(ctx, agent);
  // The API owns what it just wrote, except CLI configs: the next deploy re-asserts those.
  const ownership =
    linkedConfig.managedBy === "cli" ? {} : { managedBy: "api" as const };
  if (!flat) {
    await ctx.db.patch(linkedConfig._id, {
      name: agent.name,
      description: agent.description,
      ...ownership,
      updatedAt: Date.now(),
    });

    return;
  }

  await ctx.db.patch(linkedConfig._id, {
    name: agent.name,
    description: agent.description,
    provider: flat.provider,
    modelId: flat.modelId ?? linkedConfig.modelId,
    systemPrompt: flat.systemPrompt,
    maxTurns: flat.maxTurns,
    temperature: flat.temperature,
    maxTokens: flat.maxTokens,
    providerOptions: flat.providerOptions,
    outputFormat: flat.outputFormat,
    memoryToolEnabled: flat.memoryToolEnabled ?? linkedConfig.memoryToolEnabled,
    searchToolEnabled: flat.searchToolEnabled ?? linkedConfig.searchToolEnabled,
    searchToolConfig: flat.searchToolConfig,
    extraConfig: flat.extraConfig,
    ...ownership,
    updatedAt: Date.now(),
  });

  if (
    linkedConfig.managedBy !== "cli" &&
    linkedConfig.projectId &&
    linkedConfig.stageId
  ) {
    await syncApiAgentCanvasWiring(ctx, {
      projectId: linkedConfig.projectId,
      stageId: linkedConfig.stageId,
    });
  }
}

export async function pushEncryptedConfigToAgentRow(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
  accountId: Id<"accounts">,
): Promise<void> {
  const config = await ctx.db.get(configId);
  if (!config?.agentId) return;
  const normalized = ctx.db.normalizeId("agents", config.agentId);
  if (!normalized) return;
  const agent = await ctx.db.get(normalized);
  if (agent?.accountId !== accountId) return;

  const cipher = await accountCipherForWrite(ctx, accountId);
  const variables = await loadAgentRuntimeSecrets(ctx, configId);

  const nested = toNestedAgentConfig({
    name: config.name,
    description: config.description,
    provider: config.provider,
    modelId: config.modelId,
    systemPrompt: config.systemPrompt,
    maxTurns: config.maxTurns,
    outputFormat: config.outputFormat as Record<string, unknown> | undefined,
    providerOptions: config.providerOptions as
      | Record<string, unknown>
      | undefined,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    memoryToolEnabled: config.memoryToolEnabled,
    searchToolEnabled: config.searchToolEnabled,
    searchToolConfig: config.searchToolConfig as
      | Record<string, unknown>
      | undefined,
    extraConfig: config.extraConfig as Record<string, unknown> | undefined,
  });
  const resolved = substituteEnvPlaceholders(nested, variables);
  // `broods dev` re-pushes every agent; a fresh IV on an unchanged one would rewrite the row
  // and rebuild the account's whole channel projection.
  const current =
    agent.encryptedConfig && agent.encryptionIv && agent.encryptionTag
      ? await cipher.decrypt("agents:encryptedConfig", {
          ciphertext: agent.encryptedConfig,
          iv: agent.encryptionIv,
          tag: agent.encryptionTag,
        })
      : null;
  if (current && stableJson(current) === stableJson(resolved)) return;
  const encrypted = await cipher.encrypt("agents:encryptedConfig", resolved);

  await ctx.db.patch(normalized, {
    encryptedConfig: encrypted.ciphertext,
    encryptionIv: encrypted.iv,
    encryptionTag: encrypted.tag,
    updatedAt: Date.now(),
  });
  await refreshAccountChannelEndpoints(ctx, accountId);
}

export async function refreshAgentConfigsForEnvironmentVariable(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  name: string,
  value: string | undefined,
): Promise<void> {
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const accountId = await accountIdForProject(ctx, projectId);

  for (const config of configs) {
    const referencesVariable = config.runtimeVariables?.some(
      (entry) => entry.key === name,
    );
    if (!referencesVariable) continue;

    const previous = await loadAgentRuntimeSecrets(ctx, config._id);
    const nextVariables = { ...previous };
    if (value === undefined) {
      delete nextVariables[name];
    } else {
      nextVariables[name] = value;
    }
    const publicRuntimeVariables = await saveAgentRuntimeSecrets(
      ctx,
      config._id,
      Object.entries(nextVariables).map(([key, entryValue]) => ({
        key: key,
        value: entryValue,
      })),
    );
    await ctx.db.patch(config._id, {
      runtimeVariables: publicRuntimeVariables,
      updatedAt: Date.now(),
    });
    if (accountId) {
      await pushEncryptedConfigToAgentRow(ctx, config._id, accountId);
    }
  }
}

export async function syncAgentRowFields(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
  accountId: Id<"accounts">,
  patch: { name?: string; description?: string },
): Promise<void> {
  if (patch.name === undefined && patch.description === undefined) return;
  const config = await ctx.db.get(configId);
  if (!config?.agentId) return;
  const normalized = ctx.db.normalizeId("agents", config.agentId);
  if (!normalized) return;
  const agent = await ctx.db.get(normalized);
  if (agent?.accountId !== accountId) return;
  if (
    (patch.name === undefined || patch.name === agent.name) &&
    (patch.description === undefined || patch.description === agent.description)
  ) {
    return;
  }

  await ctx.db.patch(normalized, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
    updatedAt: Date.now(),
  });
}

// The flat columns are plaintext to every org member: mirror the source blob, which keeps
// `${NAME}` placeholders, or else the resolved blob with its secrets masked.
async function decryptAgentFlatPatch(
  ctx: MutationCtx,
  agent: Doc<"agents">,
): Promise<FlatPatch | null> {
  if (!hasEncryptionSecret()) return null;
  const cipher = await accountCipher(ctx, agent.accountId);
  if (
    agent.encryptedSourceConfig &&
    agent.sourceEncryptionIv &&
    agent.sourceEncryptionTag
  ) {
    const source = await cipher.decrypt("agents:encryptedSourceConfig", {
      ciphertext: agent.encryptedSourceConfig,
      iv: agent.sourceEncryptionIv,
      tag: agent.sourceEncryptionTag,
    });

    return source ? fromNestedAgentConfig(source) : null;
  }
  if (!agent.encryptedConfig || !agent.encryptionIv || !agent.encryptionTag) {
    return null;
  }
  const resolved = await cipher.decrypt("agents:encryptedConfig", {
    ciphertext: agent.encryptedConfig,
    iv: agent.encryptionIv,
    tag: agent.encryptionTag,
  });

  return resolved ? fromNestedAgentConfig(redactConfigSecrets(resolved)) : null;
}

// Scoped by orgId, never authId: an owner of orgs A and B would get A's agent in B's project.
async function ensureCanvasTarget(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  account: Doc<"accounts">,
  authId: string,
): Promise<{ project: Doc<"projects">; stage: Doc<"stages"> }> {
  const now = Date.now();

  // The index orders by slug; taking the oldest keeps repeated calls on one project.
  const existingProject = oldest(
    await ctx.db
      .query("projects")
      .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
      .collect(),
  );

  const project =
    existingProject ??
    (await ctx.db.get(
      await ctx.db.insert("projects", {
        authId: authId,
        orgId: orgId,
        name: account.username,
        description: `Agents provisioned through the ${account.username} account API.`,
        slug: await uniqueProjectSlug(ctx, orgId, account.username),
        updatedAt: now,
      }),
    ))!;

  // Not by authId: another org member may have created the stage.
  const existingStage = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .first();

  const stage =
    existingStage ??
    (await ctx.db.get(
      await ctx.db.insert("stages", {
        authId: authId,
        projectId: project._id,
        name: "Development",
        kind: "development",
        isDefault: true,
        updatedAt: now,
      }),
    ))!;

  return { project: project, stage: stage };
}

function flatAgentConfigFields(
  flat: FlatPatch | null,
): Pick<
  Doc<"agentConfigs">,
  | "provider"
  | "modelId"
  | "systemPrompt"
  | "maxTurns"
  | "temperature"
  | "maxTokens"
  | "providerOptions"
  | "outputFormat"
  | "memoryToolEnabled"
  | "searchToolEnabled"
  | "searchToolConfig"
  | "extraConfig"
> {
  return {
    provider: flat?.provider,
    modelId: flat?.modelId ?? "gpt-4.1-mini",
    systemPrompt: flat?.systemPrompt,
    maxTurns: flat?.maxTurns,
    temperature: flat?.temperature,
    maxTokens: flat?.maxTokens,
    providerOptions: flat?.providerOptions,
    outputFormat: flat?.outputFormat,
    memoryToolEnabled: flat?.memoryToolEnabled ?? true,
    searchToolEnabled: flat?.searchToolEnabled ?? false,
    searchToolConfig: flat?.searchToolConfig,
    extraConfig: flat?.extraConfig,
  };
}

function oldest<T extends { _creationTime: number }>(rows: T[]): T | undefined {
  return rows.reduce<T | undefined>(
    (earliest, row) =>
      earliest === undefined || row._creationTime < earliest._creationTime
        ? row
        : earliest,
    undefined,
  );
}
