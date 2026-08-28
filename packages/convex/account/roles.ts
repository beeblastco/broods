/**
 * Account role CRUD and assume-role session storage. Roles are scoped API
 * credentials: their policy is a PolicyDocument over the API action namespace,
 * and a role is exchanged for a short-lived fp_sts_ session via
 * `POST /v1/account/assume-role`. Only session-token hashes are stored.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "../_generated/server";
import { accountIdForProject } from "../model/auditEvents";
import { createRoleId, normalizeRolePolicyDocument } from "../model/roleRules";
import { accountRolesFields } from "../schema";

const roleDoc = v.object({
  ...accountRolesFields,
  _id: v.id("accountRoles"),
  _creationTime: v.number(),
});

const rolePrincipalValidator = v.object({
  accountId: v.id("accounts"),
  roleId: v.string(),
  name: v.string(),
  policy: v.any(),
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
  expiresAt: v.number(),
});

const roleStatusValidator = v.union(v.literal("active"), v.literal("disabled"));

/**
 * Create a role for an account. Scope ids arrive as strings from the HTTP
 * route and are validated against the account here.
 * @returns the created role document
 */
export const createInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    policy: v.any(),
    projectId: v.optional(v.string()),
    stageId: v.optional(v.string()),
  },
  returns: roleDoc,
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error(`Account not found: ${args.accountId}`);
    const policy = normalizeRolePolicyDocument(args.policy);
    const scope = await resolveRoleScope(
      ctx,
      args.accountId,
      args.projectId,
      args.stageId,
    );
    const now = Date.now();
    const createdId = await ctx.db.insert("accountRoles", {
      accountId: args.accountId,
      ...(scope !== null
        ? { projectId: scope.projectId, stageId: scope.stageId }
        : {}),
      roleId: createRoleId(),
      name: args.name,
      status: "active",
      policy: policy,
      createdAt: now,
      updatedAt: now,
    });
    const created = await ctx.db.get(createdId);
    if (!created) throw new Error("Failed to fetch created role");

    return created;
  },
});

/**
 * Record an assumed session. Only the SHA-256 hash of the token is stored.
 * @returns null
 */
export const createSession = internalMutation({
  args: {
    accountId: v.id("accounts"),
    roleId: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
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

/**
 * Look up one role by its public id within an account.
 * @returns the role document, or null when unknown or foreign
 */
export const getByRoleId = internalQuery({
  args: { accountId: v.id("accounts"), roleId: v.string() },
  returns: v.union(roleDoc, v.null()),
  handler: async (ctx, args) => {
    const role = await ctx.db
      .query("accountRoles")
      .withIndex("by_roleId", (q) => q.eq("roleId", args.roleId))
      .unique();

    return role && role.accountId === args.accountId ? role : null;
  },
});

/**
 * List an account's roles, active and disabled.
 * @returns role documents
 */
export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(roleDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("accountRoles")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .collect();
  },
});

/**
 * Delete a role and every session assumed from it.
 * @returns null
 */
export const removeInternal = internalMutation({
  args: { accountId: v.id("accounts"), roleId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await requireOwnedRole(ctx, args.accountId, args.roleId);
    const sessions = await ctx.db
      .query("roleSessions")
      .withIndex("by_roleId", (q) => q.eq("roleId", args.roleId))
      .collect();
    for (const session of sessions) {
      await ctx.db.delete(session._id);
    }
    await ctx.db.delete(role._id);

    return null;
  },
});

/**
 * Resolve an fp_sts_ token hash to its role principal. Null for unknown or
 * expired sessions, disabled or deleted roles, and inactive accounts.
 * @returns the principal the session acts as, or null
 */
export const resolveSession = internalQuery({
  args: { tokenHash: v.string() },
  returns: v.union(rolePrincipalValidator, v.null()),
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("roleSessions")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!session || session.expiresAt <= Date.now()) return null;
    const role = await ctx.db
      .query("accountRoles")
      .withIndex("by_roleId", (q) => q.eq("roleId", session.roleId))
      .unique();
    if (
      !role ||
      role.accountId !== session.accountId ||
      role.status !== "active"
    ) {
      return null;
    }
    const account = await ctx.db.get(role.accountId);
    if (!account || account.status !== "active") return null;

    return {
      accountId: role.accountId,
      roleId: role.roleId,
      name: role.name,
      policy: role.policy,
      ...(role.projectId !== undefined ? { projectId: role.projectId } : {}),
      ...(role.stageId !== undefined ? { stageId: role.stageId } : {}),
      expiresAt: session.expiresAt,
    };
  },
});

/**
 * Patch a role's name, policy, or status.
 * @returns null
 */
export const updateInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    roleId: v.string(),
    name: v.optional(v.string()),
    policy: v.optional(v.any()),
    status: v.optional(roleStatusValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const role = await requireOwnedRole(ctx, args.accountId, args.roleId);
    const policy =
      args.policy !== undefined
        ? normalizeRolePolicyDocument(args.policy)
        : undefined;
    await ctx.db.patch(role._id, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(policy !== undefined ? { policy: policy } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      updatedAt: Date.now(),
    });

    return null;
  },
});

async function requireOwnedRole(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  roleId: string,
): Promise<Doc<"accountRoles">> {
  const role = await ctx.db
    .query("accountRoles")
    .withIndex("by_roleId", (q) => q.eq("roleId", roleId))
    .unique();
  if (!role || role.accountId !== accountId) {
    throw new Error("Role does not belong to the supplied accountId");
  }

  return role;
}

async function resolveRoleScope(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
  projectId: string | undefined,
  stageId: string | undefined,
): Promise<{ projectId: Id<"projects">; stageId: Id<"stages"> } | null> {
  if (projectId === undefined && stageId === undefined) return null;
  if (projectId === undefined || stageId === undefined) {
    throw new Error("projectId and stageId must be provided together");
  }
  const normalizedProjectId = ctx.db.normalizeId("projects", projectId);
  const normalizedStageId = ctx.db.normalizeId("stages", stageId);
  if (!normalizedProjectId || !normalizedStageId) {
    throw new Error("projectId and stageId must reference this account");
  }
  const stage = await ctx.db.get(normalizedStageId);
  const owningAccountId = await accountIdForProject(ctx, normalizedProjectId);
  if (
    !stage ||
    stage.projectId !== normalizedProjectId ||
    owningAccountId !== accountId
  ) {
    throw new Error("projectId and stageId must reference this account");
  }

  return { projectId: normalizedProjectId, stageId: normalizedStageId };
}
