import { type Infer, v } from "convex/values";
import type { GeneratedIds } from "./types";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import {
  ensureStageDeployment,
  rotateStageUserTokenSecret,
  userTokenSecretReturn,
} from "../agent/deployments";
import { hasDashboardPermission } from "../model/access";
import { userByAuthId } from "../model/ownership/org";
import { accountCipher } from "../model/accountKeys";
import { sha256Hex } from "../model/accountSecrets";
import { deploymentRegionValidator } from "../schema";
import { refreshAgentConfigsForEnvironmentVariable } from "../model/agentSync";
import {
  auditDetailsJson,
  appendAuditEvent,
  type AuditActor,
} from "../model/auditEvents";
import {
  accountFromSecretHash,
  claimManifestRevision,
  assertEnvRefsResolved,
  assertSupportedWorkspaceSandboxMounts,
  authIdForAccount,
  ensureProject,
  ensureStage,
  envName,
  isExternalResourceKind,
  manifestRevision,
  deploymentRegionToPin,
  resourceName,
  releaseManifestSync,
  snapshotExternalConfig,
  type ExternalResourceKind,
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
  assertManifestResources,
  deleteAgentResource,
  deleteSandboxResource,
  deleteWorkspaceResource,
  pruneAgents,
  prunePolicyResources,
  pruneSandboxResources,
  pruneWorkspaceResources,
  type ReservationHolder,
  sandboxConfigByName,
  syncAgentResources,
  syncPolicyResources,
  syncSandboxResources,
  syncWorkspaceResources,
  undeclaredSandboxConfigs,
  undeclaredWorkspaceConfigs,
  workspaceConfigByName,
} from "../model/cliSyncResources";
import {
  assertEnvironmentVariableUnreferenced,
  loadEnvironmentVariableValues,
} from "../model/environmentValues";
import { upsertEnvironmentVariable } from "../model/environmentWrites";
import { deleteWorkspaceFile } from "../model/cascade";
import { resolveProjectStage } from "../model/projectScope";
import { refreshSandboxConfigsForEnvironmentVariable } from "../model/sandboxConfigSync";
import { ClientError } from "../model/clientError";
import { workspaceNamespace } from "../model/workspaceRules";

const PROJECT_TOUCH_INTERVAL_MS = 60_000;

const resourceValidator = v.object({
  kind: v.union(
    v.literal("agent"),
    v.literal("workspace"),
    v.literal("sandbox"),
    v.literal("cron"),
    v.literal("skill"),
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
  region: v.optional(deploymentRegionValidator),
  resources: v.array(resourceValidator),
});

const idsValidator = v.object({
  agents: v.record(v.string(), v.string()),
  workspaces: v.record(v.string(), v.string()),
  sandboxes: v.record(v.string(), v.string()),
  crons: v.record(v.string(), v.string()),
  skills: v.record(v.string(), v.string()),
  hooks: v.record(v.string(), v.string()),
  mcp: v.record(v.string(), v.string()),
  policies: v.record(v.string(), v.string()),
  channelRecords: v.record(v.string(), v.string()),
});

// missingPolicies: policyIds refs that resolved to nothing; a typo must not weaken the set.
const warningsValidator = v.object({
  missingPolicies: v.array(v.string()),
});

const cliAuditActorKindValidator = v.union(
  v.literal("cli"),
  v.literal("deployKey"),
);

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
  returns: v.object({ reserved: v.boolean() }),
  handler: async (ctx, args): Promise<{ reserved: boolean }> => {
    const { secretHash, project, stage, kind, name } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved)
      throw new ClientError("Project/stage not found", "not_found");
    const normalizedName = resourceName(name);
    const stageId = resolved.stageDoc._id;

    let reserved = false;
    if (kind === "agent") {
      await deleteAgentResource(
        ctx,
        account._id,
        resolved.projectDoc._id,
        stageId,
        normalizedName,
      );
    } else if (kind === "workspace") {
      await deleteWorkspaceResource(ctx, stageId, normalizedName);
    } else {
      reserved = await deleteSandboxResource(ctx, stageId, normalizedName);
    }
    await touchProject(ctx, resolved.projectDoc);

    return { reserved: reserved };
  },
});

export const deleteTargetsBySecretHash = internalQuery({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    target: v.union(
      v.object({ resources: v.array(resourceValidator) }),
      v.object({
        kind: v.union(v.literal("workspace"), v.literal("sandbox")),
        name: v.string(),
      }),
    ),
  },
  returns: v.array(
    v.union(
      v.object({ sandboxConfigId: v.id("sandboxConfigs") }),
      v.object({ namespace: v.string() }),
    ),
  ),
  handler: async (ctx, args): Promise<ReservationHolder[]> => {
    const { secretHash, project, stage, target } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved) return [];
    const stageId = resolved.stageDoc._id;

    let sandboxes: Doc<"sandboxConfigs">[];
    let workspaces: Doc<"workspaceConfigs">[];
    if ("resources" in target) {
      sandboxes = await undeclaredSandboxConfigs(
        ctx,
        stageId,
        target.resources,
      );
      workspaces = await undeclaredWorkspaceConfigs(
        ctx,
        stageId,
        target.resources,
      );
    } else if (target.kind === "sandbox") {
      const sandbox = await sandboxConfigByName(
        ctx,
        stageId,
        resourceName(target.name),
      );
      sandboxes = sandbox?.managedBy === "cli" ? [sandbox] : [];
      workspaces = [];
    } else {
      const workspace = await workspaceConfigByName(
        ctx,
        stageId,
        resourceName(target.name),
      );
      sandboxes = [];
      workspaces = workspace?.managedBy === "cli" ? [workspace] : [];
    }
    const namespaces = await Promise.all(
      workspaces.map(
        async (workspace): Promise<string> =>
          await workspaceNamespace(account._id, workspace._id),
      ),
    );

    return [
      ...sandboxes.map((sandbox): ReservationHolder => ({
        sandboxConfigId: sandbox._id,
      })),
      ...namespaces.map((namespace): ReservationHolder => ({
        namespace: namespace,
      })),
    ];
  },
});

// Returns the stored plaintext, so a reconnecting CLI need not rotate the key.
export const ensureRuntimeKeyBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    rotate: v.optional(v.boolean()),
    createdByAuthId: v.optional(v.string()),
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
      userTokenSecretHint: v.optional(v.string()),
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
    const createdByAuthId = args.createdByAuthId;
    const creator = createdByAuthId
      ? await ctx.db
          .query("users")
          .withIndex("by_authId", (q) => q.eq("authId", createdByAuthId))
          .unique()
      : null;
    const result = await ensureStageDeployment(ctx, {
      authId: projectDoc.authId,
      accountId: account._id,
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      projectSlug: projectDoc.slug ?? resourceName(args.project),
      stageSlug: stageDoc.name.toLowerCase(),
      createdBy: creator?.name,
      rotate: args.rotate === true,
    });
    if (args.auditSync) {
      const actor: AuditActor = {
        kind: args.auditSync.actorKind,
        id: args.auditSync.actorId,
      };
      await appendAuditEvent(ctx.db, {
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
      stageKind: stageDoc.kind,
      keyHint: result.keyHint,
      apiKey: result.rawApiKey,
      ...(result.userTokenSecretHint
        ? { userTokenSecretHint: result.userTokenSecretHint }
        : {}),
    };
  },
});

// An account or project key holds keys:write by issue; a login token's member must hold it now.
export const rotateUserTokenSecretBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    cliAuthId: v.optional(v.string()),
    actorKind: cliAuditActorKindValidator,
    actorId: v.optional(v.string()),
  },
  returns: v.union(v.null(), userTokenSecretReturn),
  handler: async (
    ctx,
    args,
  ): Promise<Infer<typeof userTokenSecretReturn> | null> => {
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
    const member = args.cliAuthId
      ? await userByAuthId(ctx, args.cliAuthId)
      : null;
    if (
      args.cliAuthId &&
      !(
        member &&
        (await hasDashboardPermission(
          ctx,
          projectDoc.orgId,
          member,
          "keys:write",
          { projectId: projectDoc._id, stageId: stageDoc._id },
        ))
      )
    ) {
      throw new ClientError(
        "Rotating the user token signing secret needs keys:write on this stage",
        "forbidden",
      );
    }

    return await rotateStageUserTokenSecret(ctx, projectDoc._id, stageDoc._id, {
      kind: args.actorKind,
      id: args.actorId,
    });
  },
});

// Ids before any bundle upload, so rows land in this stage, not matched by name account-wide.
export const ensureScopeBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    region: v.optional(deploymentRegionValidator),
    revision: v.optional(v.number()),
  },
  returns: v.object({
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    revision: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    revision: number;
  }> => {
    const account = await accountFromSecretHash(ctx, args.secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const projectDoc = await ensureProject(ctx, account, args.project);
    const stageDoc = await ensureStage(ctx, projectDoc, args.stage);
    // Refuse a region change before any upload; the sync pins it.
    deploymentRegionToPin(stageDoc, args.region);
    // The PUT's first write, so a sync refused here writes nothing.
    const revision = await claimManifestRevision(
      ctx,
      stageDoc._id,
      args.revision,
    );

    return {
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      revision: revision,
    };
  },
});

export const finishManifestSync = internalMutation({
  args: { stageId: v.id("stages"), revision: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await releaseManifestSync(ctx, args.stageId, args.revision);

    return null;
  },
});

// A mutation, not a query, so the decrypt and its audit insert commit together.
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
  handler: async (ctx, args): Promise<{ value: string } | null> => {
    const { secretHash, project, stage, name } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
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

    const cipher = await accountCipher(ctx, account._id);
    const decrypted = await cipher.decrypt(
      "environmentVariables:ciphertext",
      existing,
    );
    const value = typeof decrypted?.value === "string" ? decrypted.value : "";

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

export const getManifestBySecretHash = internalQuery({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({ manifest: v.any(), ids: idsValidator, revision: v.number() }),
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
      revision: await manifestRevision(ctx, stageDoc._id),
    };
  },
});

// Plain SHA-256 per request, so the CLI can compare `.env.local`; the stored valueDigest is an
// HMAC under the account key that no client can compute.
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
      valueDigest: v.string(),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{ name: string; updatedAt: number; valueDigest: string }>
  > => {
    const { secretHash, project, stage } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
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

    const cipher = await accountCipher(ctx, account._id);
    const entries: Array<{
      name: string;
      updatedAt: number;
      valueDigest: string;
    }> = [];
    for (const variable of variables) {
      const decrypted = await cipher.decrypt(
        "environmentVariables:ciphertext",
        variable,
      );
      const value = typeof decrypted?.value === "string" ? decrypted.value : "";
      entries.push({
        name: variable.name,
        updatedAt: variable.updatedAt,
        valueDigest: await sha256Hex(value),
      });
    }

    return entries.sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const listExternalResourcesForAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(
    v.object({
      kind: v.union(v.literal("skill"), v.literal("hook"), v.literal("mcp")),
      name: v.string(),
      stageId: v.id("stages"),
      externalId: v.string(),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      kind: "skill" | "hook" | "mcp";
      name: string;
      stageId: Id<"stages">;
      externalId: string;
    }>
  > => {
    const rows = await ctx.db
      .query("cliExternalResources")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();

    return rows.map((row) => ({
      kind: row.kind,
      name: row.name,
      stageId: row.stageId,
      externalId: row.externalId,
    }));
  },
});

// After the HTTP layer tried to terminate instances; returns sandboxes kept as still reserved.
export const pruneSandboxesBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    manifest: manifestValidator,
  },
  returns: v.array(v.string()),
  handler: async (ctx, args): Promise<string[]> => {
    const { secretHash, manifest } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const resolved = await resolveProjectStage(
      ctx,
      account,
      manifest.project,
      manifest.stage,
    );
    if (!resolved)
      throw new ClientError("Project/stage not found", "not_found");
    const { projectDoc, stageDoc } = resolved;

    await pruneWorkspaceResources(ctx, stageDoc._id, manifest.resources);
    const sandboxes = await pruneSandboxResources(
      ctx,
      stageDoc._id,
      manifest.resources,
    );
    await touchProject(ctx, projectDoc);

    return sandboxes.map((name): string => `sandbox "${name}"`);
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
      hooks: v.record(v.string(), v.string()),
      mcp: v.record(v.string(), v.string()),
    }),
    prune: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const account = await accountFromSecretHash(ctx, args.secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const projectDoc = await ensureProject(ctx, account, args.project);
    const stageDoc = await ensureStage(ctx, projectDoc, args.stage);
    const existing = await ctx.db
      .query("cliExternalResources")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", projectDoc._id).eq("stageId", stageDoc._id),
      )
      .collect();
    const desired = args.resources.filter(
      (entry): entry is typeof entry & { kind: ExternalResourceKind } =>
        isExternalResourceKind(entry.kind),
    );
    const desiredKeys = new Set(
      desired.map((entry) => `${entry.kind}:${resourceName(entry.name)}`),
    );
    const idsByKind: Record<ExternalResourceKind, Record<string, string>> = {
      skill: args.ids.skills,
      hook: args.ids.hooks,
      mcp: args.ids.mcp,
    };

    for (const resource of desired) {
      const name = resourceName(resource.name);
      const kind = resource.kind;
      const externalId: string | undefined = idsByKind[kind][name];
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

export const removeEnvBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    name: v.string(),
  },
  returns: v.object({ removed: v.boolean() }),
  handler: async (ctx, args): Promise<{ removed: boolean }> => {
    const { secretHash, project, stage, name } = args;
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const resolved = await resolveProjectStage(ctx, account, project, stage);
    if (!resolved)
      throw new ClientError("Project/stage not found", "not_found");
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
  handler: async (ctx, args): Promise<null> => {
    const account = await accountFromSecretHash(ctx, args.secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const resolved = await resolveProjectStage(
      ctx,
      account,
      args.project,
      args.stage,
    );
    if (!resolved)
      throw new ClientError("Project or stage not found", "not_found");
    const authId = await authIdForAccount(ctx, account);
    if (!authId) throw new Error("Account org owner not found");
    const nodeId = canvasNodeId("skill", resourceName(args.skillName));

    const existing = await ctx.db
      .query("workspaceFiles")
      .withIndex("by_projectId_nodeId_and_path", (q) =>
        q.eq("projectId", resolved.projectDoc._id).eq("nodeId", nodeId),
      )
      .collect();
    for (const file of existing) await deleteWorkspaceFile(ctx, file);

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

export const resolveCliAuth = internalQuery({
  args: {
    tokenHash: v.string(),
    keyKind: v.union(v.literal("account"), v.literal("project")),
    project: v.string(),
    stage: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      accountId: v.id("accounts"),
      secretHash: v.string(),
      scoped: v.boolean(),
      deployKeyId: v.optional(v.id("deployKeys")),
    }),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{
    accountId: Id<"accounts">;
    secretHash: string;
    scoped: boolean;
    deployKeyId?: Id<"deployKeys">;
  } | null> => {
    const { tokenHash, keyKind, project, stage } = args;

    if (keyKind === "account") {
      const account = await accountFromSecretHash(ctx, tokenHash);

      return account
        ? { accountId: account._id, secretHash: tokenHash, scoped: false }
        : null;
    }

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

export const setEnvBySecretHash = internalMutation({
  args: {
    secretHash: v.string(),
    project: v.string(),
    stage: v.string(),
    name: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const { secretHash, project, stage, value } = args;
    const name = envName(args.name);
    const account = await accountFromSecretHash(ctx, secretHash);
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    const projectDoc = await ensureProject(ctx, account, project);
    const stageDoc = await ensureStage(ctx, projectDoc, stage);
    await upsertEnvironmentVariable(ctx, {
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      name: name,
      value: value,
    });

    return null;
  },
});

// Runs before the PUT uploads skills, hooks or MCP servers, so their refs carry placeholder ids.
export const validateManifestForStage = internalQuery({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    manifest: manifestValidator,
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const envValues = await loadEnvironmentVariableValues(
      ctx,
      args.projectId,
      args.stageId,
    );
    const externalIds = await externalIdsForStage(
      ctx,
      args.projectId,
      args.stageId,
    );
    assertManifestResources(
      args.manifest.resources,
      envValues,
      externalIds.mcp,
      args.manifest.stage,
    );

    return null;
  },
});

// Sandbox configs and workspaces are pruned later, in pruneSandboxesBySecretHash.
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
    if (!account) throw new ClientError("Invalid Broods token", "unauthorized");
    assertSupportedWorkspaceSandboxMounts(manifest.resources);

    const projectDoc = await ensureProject(ctx, account, manifest.project);
    const stageDoc = await ensureStage(ctx, projectDoc, manifest.stage);
    const region = deploymentRegionToPin(stageDoc, manifest.region);
    if (region) {
      await ctx.db.patch(stageDoc._id, {
        deploymentRegion: region,
        updatedAt: Date.now(),
      });
    }
    const envValues = await loadEnvironmentVariableValues(
      ctx,
      projectDoc._id,
      stageDoc._id,
    );
    assertEnvRefsResolved(manifest.resources, envValues, manifest.stage);
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
      mcpIds: externalIds.mcp,
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
      await pruneAgents(
        ctx,
        account._id,
        projectDoc._id,
        stageDoc._id,
        manifest.resources,
      );
      await pruneChannelRecordResources(ctx, stageDoc._id, manifest.resources);
      await prunePolicyResources(ctx, stageDoc._id, manifest.resources);
    }

    await syncCanvasLayoutForManifest(ctx, {
      account: account,
      projectId: projectDoc._id,
      stageId: stageDoc._id,
      resources: manifest.resources,
      workspaceIds: workspaceIds,
      sandboxIds: sandboxIds,
    });

    await touchProject(ctx, projectDoc);
    const ids: GeneratedIds = {
      agents: agentIds,
      workspaces: workspaceIds,
      sandboxes: sandboxIds,
      crons: {},
      skills: externalIds.skills,
      hooks: externalIds.hooks,
      mcp: externalIds.mcp,
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

// Throttled: nearly every dashboard subscription reads the project doc, and `broods dev`
// syncs on every save.
async function touchProject(
  ctx: MutationCtx,
  project: Doc<"projects">,
): Promise<void> {
  const now = Date.now();
  if (now - project.updatedAt < PROJECT_TOUCH_INTERVAL_MS) return;
  await ctx.db.patch(project._id, { updatedAt: now });
}
