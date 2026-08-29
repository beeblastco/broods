/**
 * CLI manifest sync for code-defined Broods resources.
 *
 * Authenticates with the org Bearer secret and writes desired-state resources
 * into the SaaS project/stage model before syncing runtime agent rows. This
 * file holds the registered Convex functions; the sync passes and shared
 * helpers live in `model/cliSync*.ts`.
 */

import { v } from "convex/values";
import type { GeneratedIds } from "./types";
import { internalMutation, internalQuery } from "../_generated/server";
import { ensureStageDeployment } from "../agent/deployments";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "../model/agentConfigCodec";
import { refreshAgentConfigsForEnvironmentVariable } from "../model/agentSync";
import {
  auditDetailsJson,
  insertConfigAuditEvent,
  type ConfigAuditActor,
} from "../model/auditEvents";
import {
  accountFromSecretHash,
  assertEnvRefsResolved,
  assertSupportedWorkspaceSandboxMounts,
  authIdForAccount,
  ensureProject,
  ensureStage,
  envName,
  resourceName,
  snapshotExternalConfig,
} from "../model/cliSync";
import {
  canvasNodeId,
  syncCanvasLayoutForManifest,
} from "../model/cliSyncCanvas";
import {
  pruneChannelRecordResources,
  syncChannelRecordResources,
} from "../model/cliSyncChannels";
import {
  externalIdsForStage,
  idsForStage,
  resourcesForStage,
} from "../model/cliSyncManifest";
import {
  deleteAgentResource,
  deleteSandboxResource,
  deleteWorkspaceResource,
  pruneAgents,
  prunePolicyResources,
  pruneSandboxResources,
  pruneWorkspaceResources,
  syncAgentResources,
  syncPolicyResources,
  syncSandboxResources,
  syncWorkspaceResources,
} from "../model/cliSyncResources";
import {
  assertEnvironmentVariableUnreferenced,
  hashEnvironmentValue,
  loadEnvironmentVariableValues,
} from "../model/environmentValues";
import { resolveProjectStage } from "../model/projectScope";
import { refreshSandboxConfigsForEnvironmentVariable } from "../model/sandboxConfigSync";
import { stageKindForName } from "../stage";

const resourceValidator = v.object({
  kind: v.union(
    v.literal("agent"),
    v.literal("workspace"),
    v.literal("sandbox"),
    v.literal("cron"),
    v.literal("skill"),
    v.literal("tool"),
    v.literal("hook"),
    v.literal("mcp"),
    v.literal("policy"),
    v.literal("channelRecord"),
  ),
  name: v.string(),
  description: v.optional(v.string()),
  config: v.any(),
});

const manifestValidator = v.object({
  version: v.literal(1),
  project: v.string(),
  stage: v.string(),
  resources: v.array(resourceValidator),
});

const idsValidator = v.object({
  agents: v.record(v.string(), v.string()),
  workspaces: v.record(v.string(), v.string()),
  sandboxes: v.record(v.string(), v.string()),
  crons: v.record(v.string(), v.string()),
  skills: v.record(v.string(), v.string()),
  tools: v.record(v.string(), v.string()),
  hooks: v.record(v.string(), v.string()),
  mcpServers: v.record(v.string(), v.string()),
  policies: v.record(v.string(), v.string()),
  channelRecords: v.record(v.string(), v.string()),
});

/**
 * Non-fatal deploy advisories returned to the CLI. `missingPolicies` lists
 * `policy.policyIds` refs that did not resolve to a policy resource in this
 * deploy, so a typo cannot silently weaken the intended policy set. Unset
 * `env("NAME")` refs are not advisory: they fail the sync outright, see
 * `assertEnvRefsResolved`.
 */
const warningsValidator = v.object({
  missingPolicies: v.array(v.string()),
});

const cliAuditActorKindValidator = v.union(
  v.literal("cli"),
  v.literal("deployKey"),
);

export const getManifestBySecretHash = internalQuery({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ manifest: v.any(), ids: idsValidator }),
  ),
  handler: async (ctx, args) => {
    const { secretHash, project, stage } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) return null;
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved) return null;
    const { projectDoc, stageDoc } = resolved;
    const ids = await idsForStage(
      ctx,
      account._id,
      projectDoc._id,
      stageDoc._id,
    );
    const resources = await resourcesForStage(
      ctx,
      account._id,
      projectDoc._id,
      stageDoc._id,
    );

    return {
      manifest: {
        version: 1,
        project: project,
        stage: stage,
        resources: resources,
      },
      ids: ids,
    };
  },
});

/**
 * Resolves a CLI Bearer token hash to the account secret hash it authorizes with.
 * The org Bearer secret grants full account access (`scoped: false`); a project +
 * stage deploy key grants access only when the route resolves to the exact
 * project/stage the key is bound to (`scoped: true`). Returns null when the
 * token is unknown, revoked, or out of scope.
 */
export const resolveCliAuth = internalQuery({
  args: { tokenHash: v.string(), project: v.string(), stage: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("accounts"),
      secretHash: v.string(),
      scoped: v.boolean(),
      deployKeyId: v.optional(v.id("deployKeys")),
    }),
  ),
  handler: async (ctx, args) => {
    const { tokenHash, project, stage } = args;

    // Org Bearer secret → full account access.
    const account = await accountFromSecretHash(ctx, tokenHash);
    if (account)
      return { accountId: account._id, secretHash: tokenHash, scoped: false };

    // Scoped deploy key → only valid for its bound project + stage.
    const deployKey = await ctx.db
      .query("deployKeys")
      .withIndex("by_keyHash", (q) => q.eq("keyHash", tokenHash))
      .unique();
    if (!deployKey || deployKey.status !== "active") return null;

    const keyAccount = await ctx.db.get(deployKey.accountId);
    if (!keyAccount || keyAccount.status !== "active") return null;

    const resolved = await resolveProjectStage(ctx, keyAccount, project, stage);
    if (
      !resolved ||
      resolved.projectDoc._id !== deployKey.projectId ||
      resolved.stageDoc._id !== deployKey.stageId
    ) {
      return null;
    }

    return {
      accountId: keyAccount._id,
      secretHash: keyAccount.secretHash,
      scoped: true,
      deployKeyId: deployKey._id,
    };
  },
});

export const syncManifestBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    manifest: manifestValidator,
    prune: v.optional(v.boolean()),
  },
  returns: v.object({
    manifest: v.any(),
    ids: idsValidator,
    warnings: warningsValidator,
  }),
  handler: async (ctx, args) => {
    const { secretHash, manifest, prune } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new Error("Invalid Broods token");
    assertSupportedWorkspaceSandboxMounts(manifest.resources);

    const projectDoc = await ensureProject(ctx, account, manifest.project);
    const stageDoc = await ensureStage(ctx, projectDoc, manifest.stage);
    const envValues = await loadEnvironmentVariableValues(
      ctx,
      projectDoc._id,
      stageDoc._id,
    );
    assertEnvRefsResolved(manifest.resources, envValues);
    const workspaceIds = await syncWorkspaceResources(
      ctx,
      account._id,
      projectDoc._id,
      stageDoc._id,
      manifest.resources,
    );
    const policyIds = await syncPolicyResources(
      ctx,
      account._id,
      projectDoc._id,
      stageDoc._id,
      manifest.resources,
    );
    const externalIds = await externalIdsForStage(
      ctx,
      projectDoc._id,
      stageDoc._id,
    );
    const missingPolicies = new Set<string>();
    const sandboxIds = await syncSandboxResources(ctx, {
      accountId: account._id,
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      resources: manifest.resources,
      envValues: envValues,
    });
    const agentIds = await syncAgentResources(ctx, {
      account: account,
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      resources: manifest.resources,
      workspaceIds: workspaceIds,
      sandboxIds: sandboxIds,
      policyIds: policyIds,
      toolIds: externalIds.tools,
      mcpIds: externalIds.mcpServers,
      envValues: envValues,
      missingPolicies: missingPolicies,
    });

    const channelRecordIds = await syncChannelRecordResources(ctx, {
      accountId: account._id,
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      resources: manifest.resources,
      agentIds: agentIds,
      workspaceIds: workspaceIds,
      policyIds: policyIds,
    });

    if (prune === true) {
      await pruneAgents(ctx, projectDoc._id, stageDoc._id, manifest.resources);
      await pruneChannelRecordResources(ctx, stageDoc._id, manifest.resources);
      await prunePolicyResources(ctx, stageDoc._id, manifest.resources);
      await pruneWorkspaceResources(ctx, stageDoc._id, manifest.resources);
      await pruneSandboxResources(ctx, stageDoc._id, manifest.resources);
    }

    await syncCanvasLayoutForManifest(ctx, {
      account: account,
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      resources: manifest.resources,
      workspaceIds: workspaceIds,
      sandboxIds: sandboxIds,
    });

    await ctx.db.patch(projectDoc._id, { updatedAt: Date.now() });
    const ids: GeneratedIds = {
      agents: agentIds,
      workspaces: workspaceIds,
      sandboxes: sandboxIds,
      crons: {},
      skills: externalIds.skills,
      tools: externalIds.tools,
      hooks: externalIds.hooks,
      mcpServers: externalIds.mcpServers,
      policies: policyIds,
      channelRecords: channelRecordIds,
    };
    const resources = await resourcesForStage(
      ctx,
      account._id,
      projectDoc._id,
      stageDoc._id,
    );

    return {
      manifest: {
        version: 1,
        project: manifest.project,
        stage: manifest.stage,
        resources: resources,
      },
      ids: ids,
      warnings: {
        missingPolicies: [...missingPolicies].sort(),
      },
    };
  },
});

/**
 * Ensure the synced stage has a runtime API key (`fp_agent_…`) so the CLI
 * can write `BROODS_API_KEY` into `.env.local`. Returns the stored plaintext
 * so reconnecting clients do not need to rotate the key.
 */
export const ensureRuntimeKeyBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    rotate: v.optional(v.boolean()),
    auditSync: v.optional(
      v.object({
        resourceCount: v.number(),
        prune: v.boolean(),
        actorKind: cliAuditActorKindValidator,
        actorId: v.optional(v.string()),
      }),
    ),
  },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("accounts"),
      endpointId: v.string(),
      projectSlug: v.string(),
      stageSlug: v.string(),
      stageKind: v.union(
        v.literal("development"),
        v.literal("production"),
        v.literal("custom"),
      ),
      keyHint: v.string(),
      apiKey: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    const account = await accountFromSecretHash(ctx, args.secretHash);
    if (!account) return null;
    const resolved = await resolveProjectStage(
      ctx,
      account,
      args.project,
      args.stage,
    );
    if (!resolved) return null;
    const { projectDoc, stageDoc } = resolved;
    const result = await ensureStageDeployment(ctx, {
      authId: projectDoc.authId,
      accountId: account._id,
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      projectSlug: projectDoc.slug ?? resourceName(args.project),
      stageSlug: stageDoc.name.toLowerCase(),
      rotate: args.rotate === true,
    });
    if (args.auditSync) {
      const actor: ConfigAuditActor = {
        kind: args.auditSync.actorKind,
        id: args.auditSync.actorId,
      };
      await insertConfigAuditEvent(ctx.db, {
        accountId: account._id,
        projectId: projectDoc._id,
        stageId: stageDoc._id,
        actor: actor,
        action: "synced",
        resource: {
          kind: "manifest",
          name: `${args.project}/${args.stage}`,
        },
        summary: "CLI manifest synchronized",
        detailsJson: auditDetailsJson({
          resourceCount: args.auditSync.resourceCount,
          prune: args.auditSync.prune,
        }),
      });
    }

    return {
      accountId: account._id,
      endpointId: result.endpointId,
      projectSlug: result.projectSlug,
      stageSlug: result.stageSlug,
      stageKind: stageKindForName(stageDoc),
      keyHint: result.keyHint,
      apiKey: result.rawApiKey,
    };
  },
});

// The HTTP action needs these ids before it uploads tools, so tool rows land in
// the right stage instead of matching by name across the whole account.
export const ensureScopeBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
  },
  returns: v.object({
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  }),
  handler: async (ctx, args) => {
    const account = await accountFromSecretHash(ctx, args.secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const projectDoc = await ensureProject(ctx, account, args.project);
    const stageDoc = await ensureStage(ctx, projectDoc, args.stage);

    return {
      projectId: projectDoc._id,
      stageId: stageDoc._id,
    };
  },
});

export const recordExternalResourcesBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    resources: v.array(resourceValidator),
    ids: v.object({
      skills: v.record(v.string(), v.string()),
      tools: v.record(v.string(), v.string()),
      hooks: v.record(v.string(), v.string()),
      mcpServers: v.record(v.string(), v.string()),
    }),
    prune: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await accountFromSecretHash(ctx, args.secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const projectDoc = await ensureProject(ctx, account, args.project);
    const stageDoc = await ensureStage(ctx, projectDoc, args.stage);
    const existing = await ctx.db
      .query("cliExternalResources")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectDoc._id).eq("stageId", stageDoc._id),
      )
      .collect();
    const desired = args.resources.filter(
      (entry) =>
        entry.kind === "skill" ||
        entry.kind === "tool" ||
        entry.kind === "hook" ||
        entry.kind === "mcp",
    );
    const desiredKeys = new Set(
      desired.map((entry) => `${entry.kind}:${resourceName(entry.name)}`),
    );

    for (const resource of desired) {
      const name = resourceName(resource.name);
      let kind: "skill" | "tool" | "hook" | "mcp";
      let externalId: string | undefined;
      if (resource.kind === "skill") {
        kind = "skill";
        externalId = args.ids.skills[name];
      } else if (resource.kind === "tool") {
        kind = "tool";
        externalId = args.ids.tools[name];
      } else if (resource.kind === "mcp") {
        kind = "mcp";
        externalId = args.ids.mcpServers[name];
      } else {
        kind = "hook";
        externalId = args.ids.hooks[name];
      }
      if (!externalId)
        throw new Error(
          `${resource.kind}:${name} did not return an external id`,
        );
      const current = existing.find(
        (entry) => entry.kind === kind && entry.name === name,
      );
      const row = {
        accountId: account._id,
        projectId: projectDoc._id,
        stageId: stageDoc._id,
        kind: kind,
        name: name,
        description: resource.description,
        externalId: externalId,
        config: snapshotExternalConfig(resource.config),
        updatedAt: Date.now(),
      };
      if (current) await ctx.db.patch(current._id, row);
      else await ctx.db.insert("cliExternalResources", row);
    }

    if (args.prune === true) {
      for (const resource of existing) {
        if (!desiredKeys.has(`${resource.kind}:${resource.name}`))
          await ctx.db.delete(resource._id);
      }
    }

    return null;
  },
});

/**
 * Replaces the dashboard file tree for a CLI-managed skill node with uploaded bundle files.
 */
export const replaceSkillNodeFilesBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    skillName: v.string(),
    files: v.array(
      v.object({
        path: v.string(),
        name: v.string(),
        storageId: v.id("_storage"),
        mimeType: v.optional(v.string()),
        sizeBytes: v.optional(v.number()),
      }),
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const account = await accountFromSecretHash(ctx, args.secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const resolved = await resolveProjectStage(
      ctx,
      account,
      args.project,
      args.stage,
    );
    if (!resolved) throw new Error("Project or stage not found");
    const authId = await authIdForAccount(ctx, account);
    if (!authId) throw new Error("Account org owner not found");
    const nodeId = canvasNodeId("skill", resourceName(args.skillName));

    const existing = await ctx.db
      .query("workspaceFiles")
      .withIndex("by_projectId_and_nodeId", (q) =>
        q.eq("projectId", resolved.projectDoc._id).eq("nodeId", nodeId),
      )
      .collect();
    for (const file of existing) {
      if (file.storageId) await ctx.storage.delete(file.storageId);
      await ctx.db.delete(file._id);
    }

    const now = Date.now();
    for (const file of args.files) {
      await ctx.db.insert("workspaceFiles", {
        authId: authId,
        projectId: resolved.projectDoc._id,
        nodeId: nodeId,
        path: file.path,
        name: file.name,
        isFolder: false,
        storageId: file.storageId,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        createdAt: now,
        updatedAt: now,
      });
    }

    return null;
  },
});

export const deleteResourceBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    kind: v.union(
      v.literal("agent"),
      v.literal("workspace"),
      v.literal("sandbox"),
    ),
    name: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { secretHash, project, stage, kind, name } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved) throw new Error("Project/stage not found");
    const normalizedName = resourceName(name);

    if (kind === "agent") {
      await deleteAgentResource(
        ctx,
        resolved.projectDoc._id,
        resolved.stageDoc._id,
        normalizedName,
      );
    } else if (kind === "workspace") {
      await deleteWorkspaceResource(ctx, resolved.stageDoc._id, normalizedName);
    } else {
      await deleteSandboxResource(ctx, resolved.stageDoc._id, normalizedName);
    }

    await ctx.db.patch(resolved.projectDoc._id, { updatedAt: Date.now() });

    return null;
  },
});

export const setEnvBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    name: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { secretHash, project, stage, name, value } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const projectDoc = await ensureProject(ctx, account, project);
    const stageDoc = await ensureStage(ctx, projectDoc, stage);
    const normalizedName = envName(name);
    const existing = await ctx.db
      .query("environmentVariables")
      .withIndex("by_stageId_and_name", (q) =>
        q.eq("stageId", stageDoc._id).eq("name", normalizedName),
      )
      .unique();
    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error(
        "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store environment variables",
      );
    }
    const encrypted = await encryptAgentConfigBlob({ value: value }, secret);
    const valueDigest = await hashEnvironmentValue(value);
    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        valueDigest: valueDigest,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("environmentVariables", {
        projectId: projectDoc._id,
        stageId: stageDoc._id,
        name: normalizedName,
        ciphertext: encrypted.ciphertext,
        iv: encrypted.iv,
        tag: encrypted.tag,
        valueDigest: valueDigest,
        updatedAt: now,
      });
    }
    await refreshAgentConfigsForEnvironmentVariable(
      ctx,
      projectDoc._id,
      stageDoc._id,
      normalizedName,
      value,
    );
    await refreshSandboxConfigsForEnvironmentVariable(
      ctx,
      projectDoc._id,
      stageDoc._id,
      normalizedName,
      value,
    );

    return null;
  },
});

/**
 * Names, update times and value digests for the CLI `env list` / `env sync`.
 * Values are never returned — encrypted at rest and write-only by design.
 */
export const listEnvBySecretHash = internalQuery({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
  },
  returns: v.array(
    v.object({
      name: v.string(),
      updatedAt: v.number(),
      valueDigest: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const { secretHash, project, stage } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved) return [];

    const variables = await ctx.db
      .query("environmentVariables")
      .withIndex("by_projectId_and_stageId", (q) =>
        q
          .eq("projectId", resolved.projectDoc._id)
          .eq("stageId", resolved.stageDoc._id),
      )
      .collect();

    return variables
      .map((variable) => ({
        name: variable.name,
        updatedAt: variable.updatedAt,
        ...(variable.valueDigest ? { valueDigest: variable.valueDigest } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * Decrypts and returns one environment variable's plaintext value for the CLI
 * `env get`, writing an audit record of the reveal. A mutation (not a query) so
 * decryption and the audit insert happen together. Returns null when the
 * project/stage or the named variable does not exist.
 */
export const getEnvBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    name: v.string(),
    revealedByCliTokenId: v.optional(v.id("cliTokens")),
    revealedByCliAuthId: v.optional(v.string()),
    revealedByDeployKeyId: v.optional(v.id("deployKeys")),
  },
  returns: v.union(v.null(), v.object({ value: v.string() })),
  handler: async (ctx, args) => {
    const { secretHash, project, stage, name } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved) return null;
    const normalizedName = envName(name);

    const existing = await ctx.db
      .query("environmentVariables")
      .withIndex("by_stageId_and_name", (q) =>
        q.eq("stageId", resolved.stageDoc._id).eq("name", normalizedName),
      )
      .unique();
    if (!existing) return null;

    const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
    if (!secret) {
      throw new Error(
        "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to read environment variables",
      );
    }
    const decrypted = await decryptAgentConfigBlob(
      { ciphertext: existing.ciphertext, iv: existing.iv, tag: existing.tag },
      secret,
    );
    const revealed = decrypted as { value?: unknown } | null;
    const value = typeof revealed?.value === "string" ? revealed.value : "";

    await ctx.db.insert("environmentVariableReveals", {
      projectId: resolved.projectDoc._id,
      stageId: resolved.stageDoc._id,
      environmentVariableId: existing._id,
      name: normalizedName,
      source: "cli",
      revealedByAccountId: account._id,
      revealedByCliTokenId: args.revealedByCliTokenId,
      revealedByCliAuthId: args.revealedByCliAuthId,
      revealedByDeployKeyId: args.revealedByDeployKeyId,
      revealedAt: Date.now(),
    });

    return { value: value };
  },
});

/**
 * Removes one environment variable by name for the CLI `env rm`. Resolving the
 * project/stage is required; a missing variable is treated as success so
 * the command is idempotent.
 */
export const removeEnvBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    name: v.string(),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args) => {
    const { secretHash, project, stage, name } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new Error("Invalid Broods token");
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved) throw new Error("Project/stage not found");
    const normalizedName = envName(name);

    const existing = await ctx.db
      .query("environmentVariables")
      .withIndex("by_stageId_and_name", (q) =>
        q.eq("stageId", resolved.stageDoc._id).eq("name", normalizedName),
      )
      .unique();
    if (!existing) return { removed: false };
    await assertEnvironmentVariableUnreferenced(
      ctx,
      resolved.projectDoc._id,
      resolved.stageDoc._id,
      normalizedName,
    );

    await ctx.db.delete(existing._id);
    await refreshAgentConfigsForEnvironmentVariable(
      ctx,
      resolved.projectDoc._id,
      resolved.stageDoc._id,
      normalizedName,
      undefined,
    );
    await refreshSandboxConfigsForEnvironmentVariable(
      ctx,
      resolved.projectDoc._id,
      resolved.stageDoc._id,
      normalizedName,
      undefined,
    );

    return { removed: true };
  },
});
