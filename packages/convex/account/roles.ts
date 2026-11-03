import { v } from "convex/values";
import { paginationOptsValidator, type PaginationResult } from "convex/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "../_generated/server";
import { accountIdForProject } from "../model/auditEvents";
import {
  refsOutsideStage,
  resourceStageScope,
  STAGE_SCOPED_RESOURCE_TYPES,
} from "../model/projectScope";
import {
  API_POLICY_ACTIONS,
  normalizePolicyDocument,
} from "../model/policyRules";
import { createRoleId } from "../model/roleRules";
import { accountRolesFields, paginationCursorFields } from "../schema";
import { ClientError } from "../model/clientError";
import { policyDocumentValidator } from "../model/policyDocument";

const DEFAULT_PRUNE_BATCH_SIZE = 100;

const roleDoc = v.object({
  ...accountRolesFields,
  _id: v.id("accountRoles"),
  _creationTime: v.number(),
});

const roleFields = v.object(accountRolesFields);

export const rolePrincipalValidator = v.object({
  accountId: v.id("accounts"),
  roleId: v.string(),
  policy: policyDocumentValidator,
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
});

export const createInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    policy: v.any(),
    projectId: v.optional(v.string()),
    stageId: v.optional(v.string()),
  },
  returns: roleFields,
  handler: async (ctx, args) => {
    const policy = normalizePolicyDocument(args.policy, API_POLICY_ACTIONS);
    const scope = await resolveRoleScope(
      ctx,
      args.accountId,
      args.projectId,
      args.stageId,
    );
    const now = Date.now();
    const role = {
      accountId: args.accountId,
      ...(scope !== null
        ? { projectId: scope.projectId, stageId: scope.stageId }
        : {}),
      roleId: createRoleId(),
      name: args.name,
      status: "active" as const,
      policy: policy,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db.insert("accountRoles", role);

    return role;
  },
});

export const createSession = internalMutation({
  args: {
    accountId: v.id("accounts"),
    roleId: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    await ctx.db.insert("roleSessions", {
      tokenHash: args.tokenHash,
      roleId: args.roleId,
      accountId: args.accountId,
      expiresAt: args.expiresAt,
      createdAt: Date.now(),
    });

    return null;
  },
});

export const getByRoleId = internalQuery({
  args: { accountId: v.id("accounts"), roleId: v.string() },
  returns: v.union(roleDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accountRoles"> | null> => {
    return await getOwnedRole(ctx, args.accountId, args.roleId);
  },
});

export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(roleDoc),
  handler: async (ctx, args): Promise<Doc<"accountRoles">[]> => {
    return await ctx.db
      .query("accountRoles")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

export const listPage = internalQuery({
  args: {
    accountId: v.id("accounts"),
    paginationOpts: paginationOptsValidator,
  },
  returns: v.object({ page: v.array(roleDoc), ...paginationCursorFields }),
  handler: async (
    ctx,
    args,
  ): Promise<PaginationResult<Doc<"accountRoles">>> => {
    return await ctx.db
      .query("accountRoles")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .paginate(args.paginationOpts);
  },
});

export const pruneExpiredSessions = internalMutation({
  args: {
    now: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({ sessionsDeleted: v.number() }),
  handler: async (ctx, args): Promise<{ sessionsDeleted: number }> => {
    const now = args.now ?? Date.now();
    const batchSize = Math.min(
      Math.max(1, Math.floor(args.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE)),
      500,
    );
    const expired = await ctx.db
      .query("roleSessions")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(batchSize);
    for (const session of expired) {
      await ctx.db.delete(session._id);
    }
    if (expired.length === batchSize) {
      await ctx.scheduler.runAfter(
        0,
        internal.account.roles.pruneExpiredSessions,
        {
          now: now,
          batchSize: batchSize,
        },
      );
    }

    return { sessionsDeleted: expired.length };
  },
});

export const removeInternal = internalMutation({
  args: { accountId: v.id("accounts"), roleId: v.string() },
  returns: v.union(roleDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accountRoles"> | null> => {
    const role = await getOwnedRole(ctx, args.accountId, args.roleId);
    if (!role) return null;
    const sessions = await ctx.db
      .query("roleSessions")
      .withIndex("by_roleId", (q) => q.eq("roleId", args.roleId))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }
    await ctx.db.delete(role._id);

    return role;
  },
});

// The caller must load the account and check its status.
export const resolveSession = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(rolePrincipalValidator, v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("roleSessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;
    const role = await getOwnedRole(ctx, session.accountId, session.roleId);
    if (!role || role.status !== "active") return null;

    return {
      accountId: role.accountId,
      roleId: role.roleId,
      policy: role.policy,
      ...(role.projectId !== undefined ? { projectId: role.projectId } : {}),
      ...(role.stageId !== undefined ? { stageId: role.stageId } : {}),
    };
  },
});

const stageScopedTypeValidator = v.union(
  ...STAGE_SCOPED_RESOURCE_TYPES.map((type) => v.literal(type)),
);

export const resourceScope = internalQuery({
  args: {
    accountId: v.id("accounts"),
    type: stageScopedTypeValidator,
    id: v.string(),
  },
  returns: v.union(
    v.object({ projectId: v.id("projects"), stageId: v.id("stages") }),
    v.null(),
  ),
  handler: async (ctx, args) =>
    await resourceStageScope(ctx, args.accountId, args.type, args.id),
});

export const refsOutsidePin = internalQuery({
  args: {
    accountId: v.id("accounts"),
    pin: v.object({ projectId: v.string(), stageId: v.string() }),
    refs: v.array(v.object({ type: stageScopedTypeValidator, id: v.string() })),
  },
  returns: v.array(
    v.object({ type: stageScopedTypeValidator, id: v.string() }),
  ),
  handler: async (ctx, args) =>
    await refsOutsideStage(ctx, args.accountId, args.pin, args.refs),
});

export const updateInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    roleId: v.string(),
    name: v.optional(v.string()),
    policy: v.optional(v.any()),
    status: v.optional(v.union(v.literal("active"), v.literal("disabled"))),
  },
  returns: v.union(roleDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"accountRoles"> | null> => {
    const role = await getOwnedRole(ctx, args.accountId, args.roleId);
    if (!role) return null;
    const policy =
      args.policy !== undefined
        ? normalizePolicyDocument(args.policy, API_POLICY_ACTIONS)
        : undefined;
    await ctx.db.patch(role._id, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(policy !== undefined ? { policy: policy } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      updatedAt: Date.now(),
    });

    return await ctx.db.get(role._id);
  },
});

async function getOwnedRole(
  ctx: QueryCtx,
  accountId: Id<"accounts">,
  roleId: string,
): Promise<Doc<"accountRoles"> | null> {
  const role = await ctx.db
    .query("accountRoles")
    .withIndex("by_roleId", (q) => q.eq("roleId", roleId))
    .unique();

  return role && role.accountId === accountId ? role : null;
}

export async function resolveRoleScope(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  projectId: string | undefined,
  stageId: string | undefined,
): Promise<{ projectId: Id<"projects">; stageId: Id<"stages"> } | null> {
  if (projectId === undefined && stageId === undefined) return null;
  // Half a scope would silently widen what a runtime key can assume.
  if (projectId === undefined || stageId === undefined) {
    throw new ClientError("projectId and stageId must be provided together");
  }
  const normalizedProjectId = ctx.db.normalizeId("projects", projectId);
  const normalizedStageId = ctx.db.normalizeId("stages", stageId);
  if (!normalizedProjectId || !normalizedStageId) {
    throw new ClientError("projectId and stageId must reference this account");
  }
  const [stage, owningAccountId] = await Promise.all([
    ctx.db.get(normalizedStageId),
    accountIdForProject(ctx, normalizedProjectId),
  ]);
  if (
    !stage ||
    stage.projectId !== normalizedProjectId ||
    owningAccountId !== accountId
  ) {
    throw new ClientError("projectId and stageId must reference this account");
  }

  return { projectId: normalizedProjectId, stageId: normalizedStageId };
}
