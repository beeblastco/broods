/**
 * Keeps the broods `agents` row in sync with the dashboard's `agentConfigs`.
 *
 * Broods's harness queries `agents` (not `agentConfigs`) when invoking
 * an agent. Cherry-coke owns the canvas-side `agentConfigs` row; this helper
 * provisions the matching `agents` row in the same Convex transaction and
 * records its `_id` back on `agentConfigs.agentId` so the side panel's
 * "Agent ID" row surfaces a value broods actually accepts.
 *
 * The encrypted `AgentConfig` blob (model/provider/workspace/tools) requires
 * ACCOUNT_CONFIG_ENCRYPTION_SECRET to match broods's runtime secret.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
  fromNestedAgentConfig,
  substituteEnvPlaceholders,
  toNestedAgentConfig,
} from "./agentConfigCodec";
import { uniqueProjectSlug } from "../lib/slug";
import {
  loadAgentRuntimeSecrets,
  saveAgentRuntimeSecrets,
} from "./agentRuntimeSecrets";
import { syncApiAgentCanvasWiring } from "./apiCanvasSync";
import { getActiveOrgForUser } from "./ownership/org";

/**
 * Returns the broods account that owns the caller's active org, or
 * null if the user has no active org or the org is not yet provisioned.
 */
export async function resolveActiveAccountForAuthId(
  ctx: MutationCtx,
  authId: string,
): Promise<Doc<"accounts"> | null> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
  if (!user) return null;

  const org = await getActiveOrgForUser(ctx, user._id);
  if (!org) return null;

  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", org._id))
    .unique();

  return account ?? null;
}

/**
 * Ensures `agentConfigs[configId].agentId` references a live `agents` row
 * scoped to the caller's active org. Idempotent: if `agentId` is already
 * set and the referenced row exists, this returns it unchanged.
 */
export async function ensureAgentsRowForConfig(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
  authId: string,
): Promise<Id<"agents"> | null> {
  const config = await ctx.db.get(configId);
  if (!config || config.authId !== authId) return null;

  if (config.agentId) {
    const normalized = ctx.db.normalizeId("agents", config.agentId);
    if (normalized) {
      const existing = await ctx.db.get(normalized);
      if (existing) return existing._id;
    }
  }

  const account = await resolveActiveAccountForAuthId(ctx, authId);
  if (!account) return null;

  const now = Date.now();
  const agentId = await ctx.db.insert("agents", {
    accountId: account._id,
    name: config.name,
    description: config.description,
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.patch(configId, { agentId: agentId, updatedAt: now });

  return agentId;
}

/**
 * Builds the nested broods `AgentConfig` from the flat row, substitutes
 * `${ENV}` placeholders from `runtimeVariables`, encrypts with the shared
 * AES-256-GCM secret, and writes the result onto the linked `agents` row.
 *
 * Silently no-ops when the `agentConfigs` row has no linked `agentId`
 *      (`ensureAgentsRowForConfig` hasn't run yet, e.g. because the org is
 *      not provisioned with a broods account).
 * Throws when a linked core agent exists but the shared encryption secret is
 * missing, because otherwise the runtime would keep stale or empty config.
 */
export async function pushEncryptedConfigToAgentRow(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
): Promise<void> {
  const config = await ctx.db.get(configId);
  if (!config?.agentId) return;
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "ACCOUNT_CONFIG_ENCRYPTION_SECRET must be configured before syncing agent runtime config.",
    );
  }
  const normalized = ctx.db.normalizeId("agents", config.agentId);
  if (!normalized) return;
  const agent = await ctx.db.get(normalized);
  if (!agent) return;

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
      Record<string, unknown> | undefined,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    memoryToolEnabled: config.memoryToolEnabled,
    searchToolEnabled: config.searchToolEnabled,
    searchToolConfig: config.searchToolConfig as
      Record<string, unknown> | undefined,
    extraConfig: config.extraConfig as Record<string, unknown> | undefined,
  });
  const resolved = substituteEnvPlaceholders(nested, variables);
  const encrypted = await encryptAgentConfigBlob(resolved, secret);

  await ctx.db.patch(normalized, {
    encryptedConfig: encrypted.ciphertext,
    encryptionIv: encrypted.iv,
    encryptionTag: encrypted.tag,
    updatedAt: Date.now(),
  });
}

/**
 * Updates agent runtime secrets for configs that already reference an
 * environment variable, then re-pushes their encrypted harness config. Pass
 * `undefined` as the value to clear the secret when the variable is removed.
 */
export async function refreshAgentConfigsForEnvironmentVariable(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  environmentId: Id<"environments">,
  name: string,
  value: string | undefined,
): Promise<void> {
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", projectId).eq("environmentId", environmentId),
    )
    .collect();

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
    await pushEncryptedConfigToAgentRow(ctx, config._id);
  }
}

/**
 * Resolves the project + environment an account's API-created agents belong
 * to, creating them when the org has none.
 *
 * Scoped by `orgId`, never by `authId` alone: an owner with orgs A and B has
 * projects in both, so an authId-keyed lookup can drop A's agent into B's
 * project. The project is created on demand and named after the account, so
 * an org that never went through dashboard onboarding (an adopted service
 * account) still gets one meaningful project rather than a random empty one.
 */
async function ensureCanvasTarget(
  ctx: MutationCtx,
  orgId: Id<"orgs">,
  account: Doc<"accounts">,
  authId: string,
): Promise<{ project: Doc<"projects">; environment: Doc<"environments"> }> {
  const now = Date.now();

  // Oldest project in the org, so repeated calls converge on one target
  // instead of scattering agents across whichever project sorted first.
  const existingProject = await ctx.db
    .query("projects")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .first();

  const project =
    existingProject ??
    (await ctx.db.get(
      await ctx.db.insert("projects", {
        authId: authId,
        orgId: orgId,
        name: account.username,
        description: `Agents provisioned through the ${account.username} account API.`,
        slug: await uniqueProjectSlug(ctx, authId, account.username),
        updatedAt: now,
      }),
    ))!;

  // by_projectId, not by_authId_and_projectId: the environment may have been
  // created by a different org member than the one we're syncing as.
  const existingEnvironment = await ctx.db
    .query("environments")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .first();

  const environment =
    existingEnvironment ??
    (await ctx.db.get(
      await ctx.db.insert("environments", {
        authId: authId,
        projectId: project._id,
        name: "Development",
        kind: "development",
        isDefault: true,
        updatedAt: now,
      }),
    ))!;

  return { project, environment };
}

/**
 * Reverse sync: when an `agents` row is inserted via the API path (not via
 * the canvas), provision a matching `agentConfigs` row + canvas node on the
 * account's project/environment so the agent appears on the canvas
 * immediately. This is what puts an API-created agent under a project at all
 * — `agentConfigs.projectId` is the only link between the account plane and
 * the project plane. Silently no-ops when:
 *   - no org/owner can be found for the account
 *   - an agentConfigs row already references this agent
 *
 * The created agentConfigs row is intentionally minimal (name + agentId
 * pointer). The canvas user can edit the rest via the Config tab; that
 * edit path already pushes the encrypted nested AgentConfig back onto
 * this same `agents` row.
 */
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

  const ownerMembership = await ctx.db
    .query("orgMembers")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .filter((q) => q.eq(q.field("role"), "owner"))
    .first();
  const membership =
    ownerMembership ??
    (await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .first());
  if (!membership) return;

  const user = await ctx.db.get(membership.userId);
  if (!user) return;

  const { project, environment } = await ensureCanvasTarget(
    ctx,
    orgId,
    account,
    user.authId,
  );

  // Decrypt the API-supplied config blob (if any) so canvas fields mirror
  // what the API caller actually configured (provider, modelId, system
  // prompt, workspace, tools, …). Secrets in the blob are already resolved
  // — they go into extraConfig.provider/tools verbatim, which the Config
  // tab surfaces but Variables does not (we'd need the original ${KEY}
  // placeholders + variables to populate runtimeVariables, and those are
  // not transmitted on the API path).
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  const decrypted =
    secret && agent.encryptedConfig && agent.encryptionIv && agent.encryptionTag
      ? await decryptAgentConfigBlob(
          {
            ciphertext: agent.encryptedConfig,
            iv: agent.encryptionIv,
            tag: agent.encryptionTag,
          },
          secret,
        )
      : null;
  const flat = decrypted ? fromNestedAgentConfig(decrypted) : null;

  const now = Date.now();
  const configId = await ctx.db.insert("agentConfigs", {
    authId: user.authId,
    name: agent.name,
    description: agent.description,
    agentId: agentRowId,
    projectId: project._id,
    environmentId: environment._id,
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
    managedBy: "api",
    updatedAt: now,
  });

  const layout = await ctx.db
    .query("canvasLayouts")
    .withIndex("by_projectId_and_environmentId", (q) =>
      q.eq("projectId", project._id).eq("environmentId", environment._id),
    )
    .unique();

  const nextNode = {
    id: String(now),
    type: "agent" as const,
    position: { x: 120 + Math.random() * 200, y: 120 + Math.random() * 200 },
    data: {
      label: agent.name,
      status: "idle" as const,
      agentConfigId: configId,
      managedBy: "api" as const,
    },
  };

  if (layout) {
    await ctx.db.patch(layout._id, {
      nodes: [...layout.nodes, nextNode],
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("canvasLayouts", {
      authId: user.authId,
      projectId: project._id,
      environmentId: environment._id,
      nodes: [nextNode],
      edges: [],
      updatedAt: now,
    });
  }

  // Draw the wiring the config blob declares (sandbox, workspaces, skills)
  // as locked canvas nodes/edges next to the agent node.
  await syncApiAgentCanvasWiring(ctx, {
    accountId: agent.accountId,
    projectId: project._id,
    environmentId: environment._id,
  });
}

/**
 * Reverse-update sync: when an `agents` row is updated via API (PATCH
 * /v1/agents/<id>), decrypt the new blob and refresh the linked
 * `agentConfigs` flat fields + extraConfig so the canvas Details/Config tabs
 * reflect what the API caller just changed. No-op if no linked config or no
 * decryptable blob.
 */
export async function mirrorAgentRowOntoConfig(
  ctx: MutationCtx,
  agentRowId: Id<"agents">,
): Promise<void> {
  const agent = await ctx.db.get(agentRowId);
  if (!agent) return;

  const linkedConfig = await ctx.db
    .query("agentConfigs")
    .filter((q) => q.eq(q.field("agentId"), agentRowId as unknown as string))
    .first();
  if (!linkedConfig) return;

  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  const decrypted =
    secret && agent.encryptedConfig && agent.encryptionIv && agent.encryptionTag
      ? await decryptAgentConfigBlob(
          {
            ciphertext: agent.encryptedConfig,
            iv: agent.encryptionIv,
            tag: agent.encryptionTag,
          },
          secret,
        )
      : null;
  const flat = decrypted ? fromNestedAgentConfig(decrypted) : null;
  // The public API just wrote this agent, so the API owns it from here on —
  // except CLI-managed configs, whose ownership the next `broods deploy`
  // re-asserts anyway.
  const ownership =
    linkedConfig.managedBy === "cli" ? {} : { managedBy: "api" as const };
  if (!flat) {
    // At minimum mirror name/description, even when we can't decrypt.
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

  // Re-mirror the wiring (sandbox, workspaces, skills) onto the canvas so the
  // Architecture view tracks what the API caller just configured.
  if (
    linkedConfig.managedBy !== "cli" &&
    linkedConfig.projectId &&
    linkedConfig.environmentId
  ) {
    await syncApiAgentCanvasWiring(ctx, {
      accountId: agent.accountId,
      projectId: linkedConfig.projectId,
      environmentId: linkedConfig.environmentId,
    });
  }
}

/**
 * Mirrors name/description edits from `agentConfigs` onto the linked
 * `agents` row when one exists. Silently no-ops if the row is missing —
 * the next `ensureAgentsRowForConfig` call will provision it.
 */
export async function syncAgentRowFields(
  ctx: MutationCtx,
  configId: Id<"agentConfigs">,
  patch: { name?: string; description?: string },
): Promise<void> {
  if (patch.name === undefined && patch.description === undefined) return;
  const config = await ctx.db.get(configId);
  if (!config?.agentId) return;
  const normalized = ctx.db.normalizeId("agents", config.agentId);
  if (!normalized) return;
  const agent = await ctx.db.get(normalized);
  if (!agent) return;

  await ctx.db.patch(normalized, {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.description !== undefined
      ? { description: patch.description }
      : {}),
    updatedAt: Date.now(),
  });
}
