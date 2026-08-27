/**
 * Project + stage scoped runtime API keys (`fp_agent_…`).
 *
 * One key per stage invokes any deployed agent in it; the agent is chosen
 * per request by id. The dashboard surfaces the key/URLs; the CLI mints it on
 * `deploy`. The SHA-256 hash authenticates runtime calls (`getByApiKeyHash` in
 * `core`); the plaintext is also stored AES-GCM encrypted so the owner can
 * recover it for dashboard streaming and CLI reconnect without rotating.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import {
  decryptAgentConfigBlob,
  encryptAgentConfigBlob,
} from "./model/agentConfigCodec";
import {
  auditDetailsJson,
  dashboardAuditActor,
  insertConfigAuditEvent,
  type ConfigAuditActor,
} from "./model/auditEvents";
import { sha256Hex } from "./model/accountSecrets";
import { refreshAccountChannelEndpoints } from "./model/channelEndpoints";
import { getOwnedStage } from "./model/ownership/stage";
import { getProjectForRole } from "./model/ownership/project";

const DEPLOYMENT_KEY_PREFIX = "fp_agent_";

/** Safe runtime deployment scope returned to core without stored credentials. */
const agentDeploymentScopeValidator = v.object({
  accountId: v.id("accounts"),
  endpointId: v.string(),
  projectSlug: v.string(),
  stageSlug: v.string(),
});

const ensureReturn = v.object({
  _id: v.id("agentDeployments"),
  endpointId: v.string(),
  projectSlug: v.string(),
  stageSlug: v.string(),
  keyHint: v.string(),
  rawApiKey: v.string(),
});

/** Public (hash-free) view of a stage deployment for the dashboard. */
const stageDeploymentView = v.object({
  _id: v.id("agentDeployments"),
  endpointId: v.string(),
  projectSlug: v.string(),
  stageSlug: v.string(),
  keyHint: v.string(),
  updatedAt: v.number(),
});

type EnsureResult = {
  deploymentId: Id<"agentDeployments">;
  endpointId: string;
  projectSlug: string;
  stageSlug: string;
  keyHint: string;
  /** Plaintext key: freshly minted, or recovered from the stored blob. */
  rawApiKey: string;
};

/** Ensure the stage has a recoverable runtime key, creating one on first call. */
export const ensureForStage = mutation({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: ensureReturn,
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) throw new Error("Project not found.");
    const context = await resolveStageContext(ctx, projectId, stageId);
    const result = await ensureStageDeployment(ctx, {
      authId: context.authId,
      accountId: context.account._id,
      projectId: projectId,
      stageId: stageId,
      projectSlug: context.projectSlug,
      stageSlug: context.stageSlug,
    });
    await recordDeploymentAudit(ctx, dashboardAuditActor(authUser), {
      accountId: context.account._id,
      projectId: projectId,
      stageId: stageId,
      action: "ready",
      endpointId: result.endpointId,
      summary: "Stage runtime deployment is ready",
    });

    return toEnsureReturn(result);
  },
});

/**
 * Find the stage's active deployment, creating one (with a fresh key) when
 * absent. When `rotate` is true an existing key is regenerated. Returns the raw
 * key whenever it can — minted now, or decrypted from the at-rest blob.
 */
export async function ensureStageDeployment(
  ctx: MutationCtx,
  args: {
    authId: string;
    accountId: Id<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    projectSlug: string;
    stageSlug: string;
    rotate?: boolean;
  },
): Promise<EnsureResult> {
  const endpointId = endpointIdForStage(args.stageId);
  const existing = await ctx.db
    .query("agentDeployments")
    .withIndex("by_projectId_and_stageId_and_status", (q) =>
      q
        .eq("projectId", args.projectId)
        .eq("stageId", args.stageId)
        .eq("status", "active"),
    )
    .first();

  if (existing && args.rotate !== true) {
    // Keep slugs fresh (project/stage can be renamed) but reuse the key,
    // recovering its plaintext from the stored blob.
    if (
      existing.projectSlug !== args.projectSlug ||
      existing.stageSlug !== args.stageSlug
    ) {
      await ctx.db.patch(existing._id, {
        projectSlug: args.projectSlug,
        stageSlug: args.stageSlug,
        updatedAt: Date.now(),
      });
    }

    return {
      deploymentId: existing._id,
      endpointId: existing.endpointId,
      projectSlug: args.projectSlug,
      stageSlug: args.stageSlug,
      keyHint: existing.keyHint,
      rawApiKey: await decryptApiKey(existing),
    };
  }

  const rawApiKey = generateDeploymentKey();
  const apiKeyHash = await sha256Hex(rawApiKey);
  const keyHint = deploymentKeyHint(rawApiKey);
  const encryptedKey = await encryptApiKey(rawApiKey);
  const now = Date.now();

  if (existing) {
    await ctx.db.patch(existing._id, {
      apiKeyHash: apiKeyHash,
      keyHint: keyHint,
      ...encryptedKey,
      projectSlug: args.projectSlug,
      stageSlug: args.stageSlug,
      updatedAt: now,
    });
    await refreshAccountChannelEndpoints(ctx, args.accountId);

    return {
      deploymentId: existing._id,
      endpointId: existing.endpointId,
      projectSlug: args.projectSlug,
      stageSlug: args.stageSlug,
      keyHint: keyHint,
      rawApiKey: rawApiKey,
    };
  }

  const deploymentId = await ctx.db.insert("agentDeployments", {
    authId: args.authId,
    accountId: args.accountId,
    projectId: args.projectId,
    stageId: args.stageId,
    status: "active",
    endpointId: endpointId,
    projectSlug: args.projectSlug,
    stageSlug: args.stageSlug,
    apiKeyHash: apiKeyHash,
    keyHint: keyHint,
    ...encryptedKey,
    updatedAt: now,
  });
  await refreshAccountChannelEndpoints(ctx, args.accountId);

  return {
    deploymentId: deploymentId,
    endpointId: endpointId,
    projectSlug: args.projectSlug,
    stageSlug: args.stageSlug,
    keyHint: keyHint,
    rawApiKey: rawApiKey,
  };
}

/** Resolve the active stage deployment linked to one runtime agent. */
export const getByAgentId = internalQuery({
  args: {
    accountId: v.id("accounts"),
    agentId: v.string(),
  },
  returns: v.union(agentDeploymentScopeValidator, v.null()),
  handler: async (ctx, args) => {
    const runtimeAgentId = ctx.db.normalizeId("agents", args.agentId);
    if (!runtimeAgentId) return null;
    const runtimeAgent = await ctx.db.get(runtimeAgentId);
    if (!runtimeAgent || runtimeAgent.accountId !== args.accountId) return null;

    const config = await ctx.db
      .query("agentConfigs")
      .withIndex("by_agentId", (q) => q.eq("agentId", args.agentId))
      .unique();
    if (!config) return null;

    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_projectId_and_stageId_and_status", (q) =>
        q
          .eq("projectId", config.projectId)
          .eq("stageId", config.stageId)
          .eq("status", "active"),
      )
      .unique();
    if (!deployment || deployment.accountId !== args.accountId) return null;

    return {
      accountId: deployment.accountId,
      endpointId: deployment.endpointId,
      projectSlug: deployment.projectSlug,
      stageSlug: deployment.stageSlug,
    };
  },
});

/** Resolve a runtime API key hash to the account and scope it invokes. */
export const getByApiKeyHash = internalQuery({
  args: { apiKeyHash: v.string() },
  returns: v.union(agentDeploymentScopeValidator, v.null()),
  handler: async (ctx, { apiKeyHash }) => {
    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", apiKeyHash))
      .unique();
    if (!deployment || deployment.status !== "active") return null;

    const account = await ctx.db.get(deployment.accountId);
    if (!account || account.status !== "active") return null;

    return {
      accountId: deployment.accountId,
      endpointId: deployment.endpointId,
      projectSlug: deployment.projectSlug,
      stageSlug: deployment.stageSlug,
    };
  },
});

/** The stage's active deployment for display (no secret material). */
export const getForStage = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(stageDeploymentView, v.null()),
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Return null rather than throwing so a just-deleted stage doesn't
    // crash the reactive side panel before it unmounts.
    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;

    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_projectId_and_stageId_and_status", (q) =>
        q
          .eq("projectId", projectId)
          .eq("stageId", stageId)
          .eq("status", "active"),
      )
      .first();
    if (!deployment) return null;

    return {
      _id: deployment._id,
      endpointId: deployment.endpointId,
      projectSlug: deployment.projectSlug,
      stageSlug: deployment.stageSlug,
      keyHint: deployment.keyHint,
      updatedAt: deployment.updatedAt,
    };
  },
});

/**
 * Owner-only: decrypts the stage's stored runtime key so the dashboard can
 * stream logs/traces without re-minting. Returns null when the stage has no
 * deployment yet. Reactive by design, so a freshly generated key appears without
 * a reload.
 */
export const revealKeyForStage = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;

    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_projectId_and_stageId_and_status", (q) =>
        q
          .eq("projectId", projectId)
          .eq("stageId", stageId)
          .eq("status", "active"),
      )
      .first();
    if (!deployment) return null;

    return decryptApiKey(deployment);
  },
});

/**
 * Regenerate the stage's runtime key and return the new plaintext. If the
 * stage has no key yet this mints the first one (same as
 * `ensureForStage`), so a rotate is always safe to call.
 */
export const rotate = mutation({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: ensureReturn,
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForRole(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) throw new Error("Project not found.");
    const context = await resolveStageContext(ctx, projectId, stageId);
    const result = await ensureStageDeployment(ctx, {
      authId: context.authId,
      accountId: context.account._id,
      projectId: projectId,
      stageId: stageId,
      projectSlug: context.projectSlug,
      stageSlug: context.stageSlug,
      rotate: true,
    });
    await recordDeploymentAudit(ctx, dashboardAuditActor(authUser), {
      accountId: context.account._id,
      projectId: projectId,
      stageId: stageId,
      action: "key-rotated",
      endpointId: result.endpointId,
      summary: "Stage runtime key rotated",
    });

    return toEnsureReturn(result);
  },
});

/** Decrypt a deployment's stored runtime key. */
async function decryptApiKey(deployment: {
  apiKeyCiphertext: string;
  apiKeyIv: string;
  apiKeyTag: string;
}): Promise<string> {
  const decoded = await decryptAgentConfigBlob(
    {
      ciphertext: deployment.apiKeyCiphertext,
      iv: deployment.apiKeyIv,
      tag: deployment.apiKeyTag,
    },
    encryptionSecret(),
  );
  const value = (decoded as { value?: unknown } | null)?.value;

  if (typeof value !== "string")
    throw new Error("Stored runtime API key is invalid");

  return value;
}

/** Safe display label for a deployment key: prefix + last four chars. */
function deploymentKeyHint(token: string): string {
  return `${DEPLOYMENT_KEY_PREFIX}…${token.slice(-4)}`;
}

/** Encrypt a plaintext key into the three at-rest blob fields stored on the row. */
async function encryptApiKey(rawApiKey: string): Promise<{
  apiKeyCiphertext: string;
  apiKeyIv: string;
  apiKeyTag: string;
}> {
  const blob = await encryptAgentConfigBlob(
    { value: rawApiKey },
    encryptionSecret(),
  );

  return {
    apiKeyCiphertext: blob.ciphertext,
    apiKeyIv: blob.iv,
    apiKeyTag: blob.tag,
  };
}

/** Secret for AES-GCM encrypting the runtime key at rest (shared with env vars). */
function encryptionSecret(): string {
  const secret = process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "ACCOUNT_CONFIG_ENCRYPTION_SECRET is required to store runtime API keys",
    );
  }

  return secret;
}

/** Stable opaque endpoint handle for a stage's runtime API. */
function endpointIdForStage(stageId: Id<"stages">): string {
  return `stage-${stageId.slice(-8)}`;
}

/** Generate a random raw deployment key. */
function generateDeploymentKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64url = btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${DEPLOYMENT_KEY_PREFIX}${base64url}`;
}

/** Record a dashboard deployment mutation without storing runtime keys. */
async function recordDeploymentAudit(
  ctx: MutationCtx,
  actor: ConfigAuditActor,
  input: {
    accountId: Id<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    action: string;
    endpointId: string;
    summary: string;
  },
): Promise<void> {
  await insertConfigAuditEvent(ctx.db, {
    accountId: input.accountId,
    projectId: input.projectId,
    stageId: input.stageId,
    actor: actor,
    action: input.action,
    resource: {
      kind: "deployment",
      id: input.endpointId,
    },
    summary: input.summary,
    detailsJson: auditDetailsJson({ endpointId: input.endpointId }),
  });
}

/** Resolve the project's org account, slug, and the stage's slug. */
async function resolveStageContext(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<{
  account: Doc<"accounts">;
  projectSlug: string;
  stageSlug: string;
  authId: string;
}> {
  const project = await ctx.db.get(projectId);
  if (!project?.orgId)
    throw new Error("Project is not linked to an organization.");
  const stage = await ctx.db.get(stageId);
  if (!stage || stage.projectId !== projectId)
    throw new Error("Stage not found.");

  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId!))
    .unique();
  if (!account) {
    throw new Error(
      "Provision your organization's API account first (Settings → API Access).",
    );
  }

  return {
    account: account,
    projectSlug: project.slug ?? "project",
    stageSlug: stage.name.toLowerCase(),
    authId: project.authId,
  };
}

function toEnsureReturn(result: EnsureResult): {
  _id: Id<"agentDeployments">;
  endpointId: string;
  projectSlug: string;
  stageSlug: string;
  keyHint: string;
  rawApiKey: string;
} {
  return {
    _id: result.deploymentId,
    endpointId: result.endpointId,
    projectSlug: result.projectSlug,
    stageSlug: result.stageSlug,
    keyHint: result.keyHint,
    rawApiKey: result.rawApiKey,
  };
}
