/**
 * CLI manifest sync passes for the stage-scoped resource families: workspaces,
 * sandboxes, policies, and agents — plus the prune and single-delete paths.
 * Rename detection matches an unclaimed CLI-managed row whose content snapshot
 * is identical to the desired resource.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { normalizePolicyDocument } from "../agent/policies";
import {
  encryptAgentConfigBlob,
  fromNestedAgentConfig,
  substituteEnvPlaceholders,
} from "./agentConfigCodec";
import { saveAgentRuntimeSecrets } from "./agentRuntimeSecrets";
import {
  ensureAgentsRowForConfig,
  pushEncryptedConfigToAgentRow,
  syncAgentRowFields,
} from "./agentSync";
import {
  asObject,
  assertNoAccountScopedResourceConflict,
  assertSupportedWorkspaceStorage,
  authIdForAccount,
  decryptSandboxConfig,
  renameComparableAgent,
  renameComparableResource,
  resourceName,
  rewriteEnvRefs,
  rewriteResourceRefs,
  type CliResource,
} from "./cliSync";
import { isPlainObject, stableJson } from "./objects";

export async function deleteAgentResource(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  name: string,
): Promise<void> {
  const configs = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const config = configs.find((entry) => entry.name === name);
  if (!config) return;
  if (config.managedBy !== "cli") {
    throw new Error(
      `Agent "${name}" is dashboard-managed and cannot be deleted through the CLI.`,
    );
  }
  if (config.agentId) {
    const agentId = ctx.db.normalizeId("agents", config.agentId);
    if (agentId) {
      const agent = await ctx.db.get(agentId);
      if (agent) await ctx.db.delete(agentId);
    }
  }
  await ctx.db.delete(config._id);
}

export async function deleteSandboxResource(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  name: string,
): Promise<void> {
  const sandbox = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) =>
      q.eq("stageId", stageId).eq("name", name),
    )
    .unique();
  if (!sandbox) return;
  if (sandbox.managedBy !== "cli") {
    throw new Error(
      `Sandbox "${name}" is dashboard-managed and cannot be deleted through the CLI.`,
    );
  }
  await ctx.db.delete(sandbox._id);
}

export async function deleteWorkspaceResource(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  name: string,
): Promise<void> {
  const workspace = await ctx.db
    .query("workspaceConfigs")
    .withIndex("by_stageId_and_name", (q) =>
      q.eq("stageId", stageId).eq("name", name),
    )
    .unique();
  if (!workspace) return;
  if (workspace.managedBy !== "cli") {
    throw new Error(
      `Workspace "${name}" is dashboard-managed and cannot be deleted through the CLI.`,
    );
  }
  await ctx.db.delete(workspace._id);
}

export async function pruneAgents(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  resources: CliResource[],
): Promise<void> {
  const declared = new Set(
    resources
      .filter((entry) => entry.kind === "agent")
      .map((entry) => resourceName(entry.name)),
  );
  const existing = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  for (const config of existing) {
    if (config.managedBy !== "cli" || declared.has(config.name)) continue;
    if (config.agentId) {
      const agentId = ctx.db.normalizeId("agents", config.agentId);
      if (agentId) {
        const agent = await ctx.db.get(agentId);
        if (agent) await ctx.db.delete(agentId);
      }
    }
    await ctx.db.delete(config._id);
  }
}

export async function prunePolicyResources(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  resources: CliResource[],
): Promise<void> {
  const declared = new Set(
    resources
      .filter((entry) => entry.kind === "policy")
      .map((entry) => resourceName(entry.name)),
  );
  const existing = await ctx.db
    .query("agentPolicies")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const policy of existing) {
    if (policy.managedBy === "cli" && !declared.has(policy.name)) {
      await ctx.db.patch(policy._id, {
        status: "deleted",
        deletedAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }
}

export async function pruneSandboxResources(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  resources: CliResource[],
): Promise<void> {
  const declared = new Set(
    resources
      .filter((entry) => entry.kind === "sandbox")
      .map((entry) => resourceName(entry.name)),
  );
  const existing = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const sandbox of existing) {
    if (sandbox.managedBy === "cli" && !declared.has(sandbox.name))
      await ctx.db.delete(sandbox._id);
  }
}

export async function pruneWorkspaceResources(
  ctx: MutationCtx,
  stageId: Id<"stages">,
  resources: CliResource[],
): Promise<void> {
  const declared = new Set(
    resources
      .filter((entry) => entry.kind === "workspace")
      .map((entry) => resourceName(entry.name)),
  );
  // Scope to this stage so prune never reaches across stages or touches
  // account-scoped (stage-less) legacy / dashboard-shared rows.
  const existing = await ctx.db
    .query("workspaceConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  for (const workspace of existing) {
    if (workspace.managedBy === "cli" && !declared.has(workspace.name))
      await ctx.db.delete(workspace._id);
  }
}

export async function syncAgentResources(
  ctx: MutationCtx,
  options: {
    account: Doc<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    resources: CliResource[];
    workspaceIds: Record<string, string>;
    sandboxIds: Record<string, string>;
    policyIds: Record<string, string>;
    mcpIds: Record<string, string>;
    envValues: Record<string, string>;
    missingPolicies: Set<string>;
  },
): Promise<Record<string, string>> {
  const {
    account,
    projectId,
    stageId,
    resources,
    workspaceIds,
    sandboxIds,
    policyIds,
    mcpIds,
    envValues,
    missingPolicies,
  } = options;
  const ids: Record<string, string> = {};
  // Agents whose `subagent.allowed` references other agents by name. Resolved
  // to deploy-time agent ids in a second pass, once every agent row exists.
  const pendingSubagentRefs: Array<{
    configId: Id<"agentConfigs">;
    nested: Record<string, unknown>;
  }> = [];
  const existing = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stageId),
    )
    .collect();
  const agentResources = resources.filter((entry) => entry.kind === "agent");
  const desiredNames = new Set(
    agentResources.map((entry) => resourceName(entry.name)),
  );
  const existingSnapshots = new Map<Id<"agentConfigs">, string>();
  for (const config of existing) {
    existingSnapshots.set(
      config._id,
      stableJson(renameComparableAgent(config)),
    );
  }
  const claimed = new Set<Id<"agentConfigs">>();

  for (const resource of agentResources) {
    const name = resourceName(resource.name);
    const envNames = new Set<string>();
    const withEnvRefs = rewriteEnvRefs(asObject(resource.config), envNames);
    // Policy refs that resolve to no policy resource in this deploy stay
    // behind as raw strings the runtime later drops, silently weakening the
    // intended policy set. Surface them as a deploy warning instead.
    if (
      isPlainObject(withEnvRefs.policy) &&
      Array.isArray(withEnvRefs.policy.policyIds)
    ) {
      for (const entry of withEnvRefs.policy.policyIds) {
        if (typeof entry === "string" && !policyIds[entry])
          missingPolicies.add(entry);
      }
    }
    const nested = rewriteResourceRefs(withEnvRefs, {
      workspaces: workspaceIds,
      sandboxes: sandboxIds,
      policies: policyIds,
      mcp: mcpIds,
    });
    const flat = fromNestedAgentConfig(nested);
    const runtimeVariables = [...envNames].map((envNameEntry) => ({
      key: envNameEntry,
      value: envValues[envNameEntry],
    }));
    const current = existing.find((entry) => entry.name === name);
    const target =
      current ??
      existing.find(
        (entry) =>
          entry.managedBy === "cli" &&
          !claimed.has(entry._id) &&
          !desiredNames.has(entry.name) &&
          existingSnapshots.get(entry._id) ===
            stableJson(renameComparableResource(resource.description, nested)),
      );
    if (target) {
      claimed.add(target._id);
      const publicRuntimeVariables = await saveAgentRuntimeSecrets(
        ctx,
        target._id,
        runtimeVariables,
      );
      await ctx.db.patch(target._id, {
        name: name,
        description: resource.description,
        provider: flat.provider,
        modelId: flat.modelId,
        systemPrompt: flat.systemPrompt,
        maxTurns: flat.maxTurns,
        temperature: flat.temperature,
        maxTokens: flat.maxTokens,
        providerOptions: flat.providerOptions,
        outputFormat: flat.outputFormat,
        searchToolEnabled: flat.searchToolEnabled,
        searchToolConfig: flat.searchToolConfig,
        runtimeVariables: publicRuntimeVariables,
        extraConfig: flat.extraConfig,
        managedBy: "cli",
        updatedAt: Date.now(),
      });
      await ensureAgentsRowForConfig(
        ctx,
        target._id,
        target.authId,
        account._id,
      );
      await syncAgentRowFields(ctx, target._id, {
        name: name,
        description: resource.description,
      });
      await pushEncryptedConfigToAgentRow(ctx, target._id);
      const refreshed = await ctx.db.get(target._id);
      if (refreshed?.agentId) ids[name] = refreshed.agentId;
      if (hasSubagentAllowed(nested))
        pendingSubagentRefs.push({ configId: target._id, nested: nested });
    } else {
      const authId = await authIdForAccount(ctx, account);
      if (!authId) throw new Error("Account org owner not found");
      const configId = await ctx.db.insert("agentConfigs", {
        authId: authId,
        name: name,
        description: resource.description,
        projectId: projectId,
        stageId: stageId,
        provider: flat.provider,
        modelId: flat.modelId,
        systemPrompt: flat.systemPrompt,
        maxTurns: flat.maxTurns,
        temperature: flat.temperature,
        maxTokens: flat.maxTokens,
        providerOptions: flat.providerOptions,
        outputFormat: flat.outputFormat,
        searchToolEnabled: flat.searchToolEnabled,
        searchToolConfig: flat.searchToolConfig,
        runtimeVariables: runtimeVariables.map((entry) => ({
          key: entry.key,
          value: "",
        })),
        extraConfig: flat.extraConfig,
        managedBy: "cli",
        updatedAt: Date.now(),
      });
      await saveAgentRuntimeSecrets(ctx, configId, runtimeVariables);
      await ensureAgentsRowForConfig(ctx, configId, authId, account._id);
      await pushEncryptedConfigToAgentRow(ctx, configId);
      const created = await ctx.db.get(configId);
      if (created?.agentId) ids[name] = created.agentId;
      if (hasSubagentAllowed(nested))
        pendingSubagentRefs.push({ configId: configId, nested: nested });
    }
  }

  await resolveSubagentReferences(ctx, pendingSubagentRefs, ids);

  return ids;
}

export async function syncPolicyResources(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  resources: CliResource[],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const policies = resources.filter((entry) => entry.kind === "policy");
  if (policies.length === 0) return ids;

  const existing = await ctx.db
    .query("agentPolicies")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const desiredNames = new Set(
    policies.map((entry) => resourceName(entry.name)),
  );
  const claimed = new Set<Id<"agentPolicies">>();

  for (const resource of policies) {
    const name = resourceName(resource.name);
    // Same validation gate as the CRUD mutations: a malformed manifest
    // policy must fail the deploy, not reach OPA at runtime.
    const document = normalizePolicyDocument(resource.config);
    const current = existing.find((entry) => entry.name === name);
    const target =
      current ??
      existing.find(
        (entry) =>
          entry.managedBy === "cli" &&
          !claimed.has(entry._id) &&
          !desiredNames.has(entry.name) &&
          stableJson(
            renameComparableResource(entry.description, entry.document),
          ) ===
            stableJson(
              renameComparableResource(resource.description, resource.config),
            ),
      );
    if (target) {
      claimed.add(target._id);
      await ctx.db.patch(target._id, {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        name: name,
        description: resource.description,
        document: document,
        status: "active",
        managedBy: "cli",
        updatedAt: Date.now(),
        deletedAt: undefined,
      });
      ids[name] = target._id;
    } else {
      const now = Date.now();
      const id = await ctx.db.insert("agentPolicies", {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        name: name,
        description: resource.description,
        document: document,
        status: "active",
        managedBy: "cli",
        createdAt: now,
        updatedAt: now,
      });
      ids[name] = id;
    }
  }

  return ids;
}

export async function syncSandboxResources(
  ctx: MutationCtx,
  options: {
    accountId: Id<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    resources: CliResource[];
    envValues: Record<string, string>;
  },
): Promise<Record<string, string>> {
  const { accountId, projectId, stageId, resources, envValues } = options;
  const ids: Record<string, string> = {};
  const sandboxes = resources.filter((entry) => entry.kind === "sandbox");
  if (sandboxes.length === 0) return ids;

  // sandboxConfigs is a shared SaaS table owned by broods: the blob is
  // stored encrypted at rest (envVars/options may carry provider secrets).
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to sync sandbox configs",
    );
  }
  const existing = await ctx.db
    .query("sandboxConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const desiredNames = new Set(
    sandboxes.map((entry) => resourceName(entry.name)),
  );
  const existingConfigs = new Map<
    Id<"sandboxConfigs">,
    Record<string, unknown>
  >();
  for (const sandbox of existing) {
    existingConfigs.set(
      sandbox._id,
      await decryptSandboxConfig(sandbox, secret),
    );
  }
  const claimed = new Set<Id<"sandboxConfigs">>();

  for (const resource of sandboxes) {
    const name = resourceName(resource.name);
    // Core reads the sandbox blob verbatim, so `env("NAME")` resolves here.
    // The rename comparison runs on the resolved form too.
    const envNames = new Set<string>();
    // `sourceConfig` keeps `${NAME}` placeholders; `resolvedConfig` bakes in
    // current values. We store both: resolved for core to read, source so
    // `refreshSandboxConfigsForEnvironmentVariable` can re-resolve on a later
    // env-var change without a CLI re-sync (parity with agent configs).
    const sourceConfig = rewriteEnvRefs(asObject(resource.config), envNames);
    const resolvedConfig = substituteEnvPlaceholders(sourceConfig, envValues);
    const runtimeVariables = [...envNames].map((key) => ({
      key: key,
      value: "",
    }));
    const encrypted = await encryptAgentConfigBlob(resolvedConfig, secret);
    const encryptedSource = await encryptAgentConfigBlob(sourceConfig, secret);
    const current = existing.find((entry) => entry.name === name);
    const target =
      current ??
      existing.find(
        (entry) =>
          entry.managedBy === "cli" &&
          !claimed.has(entry._id) &&
          !desiredNames.has(entry.name) &&
          stableJson(
            renameComparableResource(
              entry.description,
              existingConfigs.get(entry._id) ?? {},
            ),
          ) ===
            stableJson(
              renameComparableResource(resource.description, resolvedConfig),
            ),
      );
    if (target) {
      claimed.add(target._id);
      await ctx.db.patch(target._id, {
        accountId: accountId,
        projectId: projectId,
        name: name,
        description: resource.description,
        encryptedConfig: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        encryptedSourceConfig: encryptedSource.ciphertext,
        sourceEncryptionIv: encryptedSource.iv,
        sourceEncryptionTag: encryptedSource.tag,
        runtimeVariables: runtimeVariables,
        managedBy: "cli",
        updatedAt: Date.now(),
      });
      ids[name] = target._id;
    } else {
      await assertNoAccountScopedResourceConflict(ctx, {
        table: "sandboxConfigs",
        accountId: accountId,
        name: name,
      });
      const now = Date.now();
      const id = await ctx.db.insert("sandboxConfigs", {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        name: name,
        description: resource.description,
        encryptedConfig: encrypted.ciphertext,
        encryptionIv: encrypted.iv,
        encryptionTag: encrypted.tag,
        encryptedSourceConfig: encryptedSource.ciphertext,
        sourceEncryptionIv: encryptedSource.iv,
        sourceEncryptionTag: encryptedSource.tag,
        runtimeVariables: runtimeVariables,
        managedBy: "cli",
        createdAt: now,
        updatedAt: now,
      });
      ids[name] = id;
    }
  }

  return ids;
}

export async function syncWorkspaceResources(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  resources: CliResource[],
): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const existing = await ctx.db
    .query("workspaceConfigs")
    .withIndex("by_stageId_and_name", (q) => q.eq("stageId", stageId))
    .collect();
  const workspaceResources = resources.filter(
    (entry) => entry.kind === "workspace",
  );
  const desiredNames = new Set(
    workspaceResources.map((entry) => resourceName(entry.name)),
  );
  const claimed = new Set<Id<"workspaceConfigs">>();
  for (const resource of workspaceResources) {
    assertSupportedWorkspaceStorage(resource);
    const name = resourceName(resource.name);
    const current = existing.find((entry) => entry.name === name);
    const target =
      current ??
      existing.find(
        (entry) =>
          entry.managedBy === "cli" &&
          !claimed.has(entry._id) &&
          !desiredNames.has(entry.name) &&
          stableJson(
            renameComparableResource(entry.description, entry.config),
          ) ===
            stableJson(
              renameComparableResource(resource.description, resource.config),
            ),
      );
    if (target) {
      claimed.add(target._id);
      await ctx.db.patch(target._id, {
        accountId: accountId,
        projectId: projectId,
        name: name,
        description: resource.description,
        config: resource.config,
        managedBy: "cli",
        updatedAt: Date.now(),
      });
      ids[name] = target._id;
    } else {
      await assertNoAccountScopedResourceConflict(ctx, {
        table: "workspaceConfigs",
        accountId: accountId,
        name: name,
      });
      const now = Date.now();
      const id = await ctx.db.insert("workspaceConfigs", {
        accountId: accountId,
        projectId: projectId,
        stageId: stageId,
        name: name,
        description: resource.description,
        config: resource.config,
        managedBy: "cli",
        createdAt: now,
        updatedAt: now,
      });
      ids[name] = id;
    }
  }

  return ids;
}

/** True when an agent's nested config lists other agents in `subagent.allowed`. */
function hasSubagentAllowed(nested: Record<string, unknown>): boolean {
  const subagent = nested.subagent;

  return (
    isPlainObject(subagent) &&
    Array.isArray(subagent.allowed) &&
    subagent.allowed.length > 0
  );
}

/**
 * Second pass over agents that reference other agents in `subagent.allowed`.
 * Rewrites declared agent names to their deploy-time agent ids (leaving any
 * non-declared string, e.g. a literal agent id, untouched) and re-pushes the
 * encrypted config so the runtime can dispatch the named subagents.
 */
async function resolveSubagentReferences(
  ctx: MutationCtx,
  pending: Array<{
    configId: Id<"agentConfigs">;
    nested: Record<string, unknown>;
  }>,
  agentIds: Record<string, string>,
): Promise<void> {
  for (const { configId, nested } of pending) {
    const subagent = nested.subagent as Record<string, unknown>;
    const allowed = (subagent.allowed as unknown[]).map((entry) =>
      typeof entry === "string" && agentIds[entry] ? agentIds[entry] : entry,
    );
    const resolved = { ...nested, subagent: { ...subagent, allowed: allowed } };
    const flat = fromNestedAgentConfig(resolved);
    await ctx.db.patch(configId, {
      extraConfig: flat.extraConfig,
      updatedAt: Date.now(),
    });
    await pushEncryptedConfigToAgentRow(ctx, configId);
  }
}
