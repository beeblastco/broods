// Stage runtime keys (`bsk_…`): one per stage invokes any of its agents, picked per request.
// The SHA-256 hash authenticates; the plaintext is also sealed so the owner can recover it.

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { authKit, type AuthUser, deriveName } from "../auth";
import { accountCipher, accountCipherForWrite } from "../model/accountKeys";
import {
  auditDetailsJson,
  dashboardAuditActor,
  appendAuditEvent,
  type AuditActor,
} from "../model/auditEvents";
import { accountDoc } from "../model/accountDoc";
import { requireDashboardPermission } from "../model/access";
import {
  keyHint,
  randomToken,
  RUNTIME_KEY_PREFIX,
  sha256Hex,
} from "../model/accountSecrets";
import { refreshAccountChannelEndpoints } from "../model/channelEndpoints";
import { userByAuthId } from "../model/ownership/org";
import { getOwnedStage, getStageForWrite } from "../model/ownership/stage";
import { getProjectForWrite } from "../model/ownership/project";
import { USER_TOKEN_SECRET_PREFIX } from "../model/userToken";
import {
  sealStageSessionTicket,
  STAGE_SESSION_TICKET_TTL_MS,
} from "../model/stageSessionTicket";

const PROVISION_ACCOUNT_FIRST =
  "Provision your organization's API account first (Settings → API Access).";

export const stageSessionValidator = v.object({
  token: v.string(),
  expiresAt: v.number(),
  projectSlug: v.string(),
  stageSlug: v.string(),
});

export type StageSession = Infer<typeof stageSessionValidator>;

const agentDeploymentScopeValidator = v.object({
  accountId: v.id("accounts"),
  projectId: v.id("projects"),
  stageId: v.id("stages"),
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

const revealedKeyValidator = v.object({
  apiKey: v.string(),
  createdAt: v.optional(v.number()),
  createdBy: v.optional(v.string()),
  lastUsedAt: v.optional(v.number()),
});

export type RevealedKey = Infer<typeof revealedKeyValidator>;

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
  rawApiKey: string;
  userTokenSecretHint?: string;
};

export const ensureForStage = mutation({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: ensureReturn,
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForWrite(ctx, authUser.id, projectId);
    if (!project) throw new Error("Project not found.");
    const member = await userByAuthId(ctx, authUser.id);
    if (!member) throw new Error("User row not found");
    await requireDashboardPermission(ctx, project.orgId, member, "keys:write", {
      projectId: projectId,
      stageId: stageId,
    });
    const result = await readyStageDeployment(
      ctx,
      authUser,
      projectId,
      stageId,
    );
    if (!result) throw new Error(PROVISION_ACCOUNT_FIRST);

    return toEnsureReturn(result);
  },
});

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
      projectId: deployment.projectId,
      stageId: deployment.stageId,
      endpointId: deployment.endpointId,
      projectSlug: deployment.projectSlug,
      stageSlug: deployment.stageSlug,
    };
  },
});

export const getByApiKeyHash = internalQuery({
  args: { apiKeyHash: v.string() },
  // The signing secret stays sealed: core opens it only when a request carries a user token.
  returns: v.union(
    v.object({
      ...agentDeploymentScopeValidator.fields,
      account: accountDoc,
      userTokenSecret: v.optional(
        v.object({ ciphertext: v.string(), iv: v.string(), tag: v.string() }),
      ),
    }),
    v.null(),
  ),
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
      projectId: deployment.projectId,
      stageId: deployment.stageId,
      endpointId: deployment.endpointId,
      projectSlug: deployment.projectSlug,
      stageSlug: deployment.stageSlug,
      account: account,
      ...(deployment.userTokenSecretCiphertext &&
      deployment.userTokenSecretIv &&
      deployment.userTokenSecretTag
        ? {
            userTokenSecret: {
              ciphertext: deployment.userTokenSecretCiphertext,
              iv: deployment.userTokenSecretIv,
              tag: deployment.userTokenSecretTag,
            },
          }
        : {}),
    };
  },
});

export const getForStage = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(stageDeploymentView, v.null()),
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    // Null, not a throw: a just-deleted stage must not crash the reactive side panel.
    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;

    const deployment = await activeDeployment(ctx, projectId, stageId);
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

// Any member may mint this, so core never accepts it for a machine sandbox claim.
export const mintStageSession = mutation({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(
    v.object({ token: v.string(), expiresAt: v.number() }),
    v.null(),
  ),
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<{ token: string; expiresAt: number } | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getStageForWrite(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;
    const session = await mintStageSessionTicket(ctx, projectId, stageId);

    return session
      ? { token: session.token, expiresAt: session.expiresAt }
      : null;
  },
});

// Callers check read access, and pass `sandboxWrite` only once the member may write sandboxes.
export async function mintStageSessionTicket(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  sandboxWrite = false,
): Promise<StageSession | null> {
  const deployment = await activeDeployment(ctx, projectId, stageId);
  if (!deployment) return null;

  const expiresAt = Date.now() + STAGE_SESSION_TICKET_TTL_MS;
  const token = await sealStageSessionTicket(
    {
      accountId: deployment.accountId,
      endpointId: deployment.endpointId,
      projectId: projectId,
      projectSlug: deployment.projectSlug,
      stageId: stageId,
      stageSlug: deployment.stageSlug,
      ...(sandboxWrite ? { sandboxWrite: true as const } : {}),
      expiresAt: expiresAt,
    },
    stageTicketSecret(),
  );

  return {
    token: token,
    expiresAt: expiresAt,
    projectSlug: deployment.projectSlug,
    stageSlug: deployment.stageSlug,
  };
}

export const revealKeyForStage = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(revealedKeyValidator, v.null()),
  handler: async (ctx, { projectId, stageId }): Promise<RevealedKey | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getOwnedStage(ctx, authUser.id, stageId, "admin");
    if (!stage || stage.projectId !== projectId) return null;

    const deployment = await activeDeployment(ctx, projectId, stageId);
    if (!deployment) return null;

    return {
      apiKey: await decryptApiKey(ctx, deployment),
      createdAt: deployment.createdAt,
      createdBy: deployment.createdBy,
      lastUsedAt: deployment.lastUsedAt,
    };
  },
});

// Core throttles this per key in process, so it is not a write per request.
export const touchLastUsed = internalMutation({
  args: { apiKeyHash: v.string(), usedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { apiKeyHash, usedAt }): Promise<null> => {
    const deployment = await ctx.db
      .query("agentDeployments")
      .withIndex("by_apiKeyHash", (q) => q.eq("apiKeyHash", apiKeyHash))
      .unique();
    if (deployment && (deployment.lastUsedAt ?? 0) < usedAt) {
      await ctx.db.patch(deployment._id, { lastUsedAt: usedAt });
    }

    return null;
  },
});

export const rotate = mutation({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: ensureReturn,
  handler: async (ctx, { projectId, stageId }) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForWrite(ctx, authUser.id, projectId);
    if (!project) throw new Error("Project not found.");
    const member = await userByAuthId(ctx, authUser.id);
    if (!member) throw new Error("User row not found");
    await requireDashboardPermission(ctx, project.orgId, member, "keys:write", {
      projectId: projectId,
      stageId: stageId,
    });
    const context = await resolveStageContext(ctx, projectId, stageId);
    if (!context) throw new Error(PROVISION_ACCOUNT_FIRST);
    const result = await ensureStageDeployment(ctx, {
      authId: context.authId,
      accountId: context.account._id,
      projectId: projectId,
      stageId: stageId,
      projectSlug: context.projectSlug,
      stageSlug: context.stageSlug,
      createdBy: deriveName(authUser),
      createdByUserId: member._id,
      rotate: true,
    });
    await recordDeploymentAudit(ctx, dashboardAuditActor(authUser), {
      accountId: context.account._id,
      projectId: projectId,
      stageId: stageId,
      action: "key-rotated",
      endpointId: result.endpointId,
      summary: "Runtime key rotated",
    });

    return toEnsureReturn(result);
  },
});

const userTokenSecretView = v.object({
  hint: v.string(),
  createdAt: v.optional(v.number()),
});

export const userTokenSecretReturn = v.object({
  secret: v.string(),
  hint: v.string(),
});

export const userTokenSecretForStage = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(userTokenSecretView, v.null()),
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<Infer<typeof userTokenSecretView> | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const stage = await getOwnedStage(ctx, authUser.id, stageId);
    if (!stage || stage.projectId !== projectId) return null;
    const deployment = await activeDeployment(ctx, projectId, stageId);
    if (!deployment?.userTokenSecretHint) return null;

    return {
      hint: deployment.userTokenSecretHint,
      createdAt: deployment.userTokenSecretCreatedAt,
    };
  },
});

export const rotateUserTokenSecret = mutation({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: userTokenSecretReturn,
  handler: async (
    ctx,
    { projectId, stageId },
  ): Promise<Infer<typeof userTokenSecretReturn>> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");

    const project = await getProjectForWrite(ctx, authUser.id, projectId);
    if (!project) throw new Error("Project not found.");
    const member = await userByAuthId(ctx, authUser.id);
    if (!member) throw new Error("User row not found");
    await requireDashboardPermission(ctx, project.orgId, member, "keys:write", {
      projectId: projectId,
      stageId: stageId,
    });
    const rotated = await rotateStageUserTokenSecret(
      ctx,
      projectId,
      stageId,
      dashboardAuditActor(authUser),
    );
    if (!rotated) throw new Error("Generate the stage's runtime key first.");

    return rotated;
  },
});

// The caller has already checked `keys:write`.
export async function rotateStageUserTokenSecret(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
  actor: AuditActor,
): Promise<Infer<typeof userTokenSecretReturn> | null> {
  const deployment = await activeDeployment(ctx, projectId, stageId);
  if (!deployment) return null;

  const secret = randomToken(USER_TOKEN_SECRET_PREFIX);
  const cipher = await accountCipherForWrite(ctx, deployment.accountId);
  const blob = await cipher.encrypt(
    "agentDeployments:userTokenSecretCiphertext",
    { value: secret },
  );
  const hint = keyHint(USER_TOKEN_SECRET_PREFIX, secret);
  const now = Date.now();
  await ctx.db.patch(deployment._id, {
    userTokenSecretCiphertext: blob.ciphertext,
    userTokenSecretIv: blob.iv,
    userTokenSecretTag: blob.tag,
    userTokenSecretHint: hint,
    userTokenSecretCreatedAt: now,
    updatedAt: now,
  });
  await recordDeploymentAudit(ctx, actor, {
    accountId: deployment.accountId,
    projectId: projectId,
    stageId: stageId,
    action: "user-token-secret-rotated",
    endpointId: deployment.endpointId,
    summary: "User token signing secret rotated",
  });

  return { secret: secret, hint: hint };
}

export async function readyStageDeployment(
  ctx: MutationCtx,
  user: AuthUser,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<EnsureResult | null> {
  const context = await resolveStageContext(ctx, projectId, stageId);
  if (!context) return null;
  const result = await ensureStageDeployment(ctx, {
    authId: context.authId,
    accountId: context.account._id,
    projectId: projectId,
    stageId: stageId,
    projectSlug: context.projectSlug,
    stageSlug: context.stageSlug,
    createdBy: deriveName(user),
    createdByUserId: (await userByAuthId(ctx, user.id))?._id,
  });
  await recordDeploymentAudit(ctx, dashboardAuditActor(user), {
    accountId: context.account._id,
    projectId: projectId,
    stageId: stageId,
    action: "ready",
    endpointId: result.endpointId,
    summary: "Stage runtime deployment is ready",
  });

  return result;
}

export async function ensureStageDeployment(
  ctx: MutationCtx,
  args: {
    authId: string;
    accountId: Id<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    projectSlug: string;
    stageSlug: string;
    createdBy?: string;
    createdByUserId?: Id<"users">;
    rotate?: boolean;
  },
): Promise<EnsureResult> {
  const endpointId = endpointIdForStage(args.stageId);
  const existing = await activeDeployment(ctx, args.projectId, args.stageId);

  if (existing && args.rotate !== true) {
    // A rename changes the slugs, never the key.
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
      rawApiKey: await decryptApiKey(ctx, existing),
      userTokenSecretHint: existing.userTokenSecretHint,
    };
  }

  const rawApiKey = randomToken(RUNTIME_KEY_PREFIX);
  const keyFields = await runtimeKeyFields(ctx, args.accountId, rawApiKey);
  const keyHint = keyFields.keyHint;
  const now = Date.now();

  if (existing) {
    await ctx.db.patch(existing._id, {
      ...keyFields,
      projectSlug: args.projectSlug,
      stageSlug: args.stageSlug,
      createdAt: now,
      createdBy: args.createdBy,
      createdByUserId: args.createdByUserId,
      lastUsedAt: undefined,
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
      userTokenSecretHint: existing.userTokenSecretHint,
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
    ...keyFields,
    createdAt: now,
    createdBy: args.createdBy,
    createdByUserId: args.createdByUserId,
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

async function decryptApiKey(
  ctx: QueryCtx | MutationCtx,
  deployment: {
    accountId: Id<"accounts">;
    apiKeyCiphertext: string;
    apiKeyIv: string;
    apiKeyTag: string;
  },
): Promise<string> {
  const cipher = await accountCipher(ctx, deployment.accountId);
  const decoded = await cipher.decrypt("agentDeployments:apiKeyCiphertext", {
    ciphertext: deployment.apiKeyCiphertext,
    iv: deployment.apiKeyIv,
    tag: deployment.apiKeyTag,
  });
  const value = decoded?.value;

  if (typeof value !== "string")
    throw new Error("Stored runtime key is invalid");

  return value;
}

async function runtimeKeyFields(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  rawApiKey: string,
): Promise<
  Pick<
    Doc<"agentDeployments">,
    "apiKeyHash" | "keyHint" | "apiKeyCiphertext" | "apiKeyIv" | "apiKeyTag"
  >
> {
  const cipher = await accountCipherForWrite(ctx, accountId);
  const blob = await cipher.encrypt("agentDeployments:apiKeyCiphertext", {
    value: rawApiKey,
  });

  return {
    apiKeyHash: await sha256Hex(rawApiKey),
    keyHint: keyHint(RUNTIME_KEY_PREFIX, rawApiKey),
    apiKeyCiphertext: blob.ciphertext,
    apiKeyIv: blob.iv,
    apiKeyTag: blob.tag,
  };
}

async function activeDeployment(
  ctx: QueryCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<Doc<"agentDeployments"> | null> {
  return await ctx.db
    .query("agentDeployments")
    .withIndex("by_projectId_and_stageId_and_status", (q) =>
      q
        .eq("projectId", projectId)
        .eq("stageId", stageId)
        .eq("status", "active"),
    )
    .first();
}

function endpointIdForStage(stageId: Id<"stages">): string {
  return `stage-${stageId.slice(-8)}`;
}

async function recordDeploymentAudit(
  ctx: MutationCtx,
  actor: AuditActor,
  input: {
    accountId: Id<"accounts">;
    projectId: Id<"projects">;
    stageId: Id<"stages">;
    action: string;
    endpointId: string;
    summary: string;
  },
): Promise<void> {
  await appendAuditEvent(ctx.db, {
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

async function resolveStageContext(
  ctx: MutationCtx,
  projectId: Id<"projects">,
  stageId: Id<"stages">,
): Promise<{
  account: Doc<"accounts">;
  projectSlug: string;
  stageSlug: string;
  authId: string;
} | null> {
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("Project not found.");
  const stage = await ctx.db.get(stageId);
  if (!stage || stage.projectId !== projectId)
    throw new Error("Stage not found.");

  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId))
    .unique();
  if (!account) return null;

  return {
    account: account,
    projectSlug: project.slug ?? "project",
    stageSlug: stage.name.toLowerCase(),
    authId: project.authId,
  };
}

/** Same value as core's `STAGE_TICKET_SECRET`, which verifies what this signs. */
function stageTicketSecret(): string {
  const secret = process.env.STAGE_TICKET_SECRET;
  if (!secret) {
    throw new Error(
      "STAGE_TICKET_SECRET is required to mint stage session tickets",
    );
  }

  return secret;
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
