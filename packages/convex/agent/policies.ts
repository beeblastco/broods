/**
 * Agent policy CRUD for dashboard, CLI sync, and core runtime reads.
 */

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { authKit } from "../auth";
import { getOwnedStage } from "../model/ownership/stage";
import { getProjectForRole } from "../model/ownership/project";
import { resolveActiveAccountForAuthId } from "../model/agentSync";
import { isPlainObject } from "../model/objects";
import { POLICY_ACTIONS } from "../model/policyRules";
import { agentPoliciesFields } from "../schema";

// Sourced from the CRUD normalizer rather than restated: this copy had gone
// stale and silently refused every `agent.invoke` rule the runtime supports.
const POLICY_ACTION_SET = new Set<string>(POLICY_ACTIONS);

const policyDoc = v.object({
  ...agentPoliciesFields,
  _id: v.id("agentPolicies"),
  _creationTime: v.number(),
});

const policyStatusValidator = v.union(
  v.literal("active"),
  v.literal("deleted"),
);

/**
 * Creates a dashboard-owned policy in one stage.
 * @param args policy fields
 * @returns created policy id
 */
export const create = mutation({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    name: v.string(),
    description: v.optional(v.string()),
    document: v.any(),
  },
  returns: v.id("agentPolicies"),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(
      ctx,
      user.id,
      args.projectId,
      "admin",
    );
    if (!project) throw new Error("Project not found.");
    const stage = await getOwnedStage(ctx, user.id, args.stageId);
    if (!stage || stage.projectId !== args.projectId)
      throw new Error("Stage not found.");
    const account = await resolveActiveAccountForAuthId(ctx, user.id);
    if (!account) throw new Error("Broods account not provisioned.");

    // CLI sync adopts policies by exact (stageId, name), so a
    // duplicate dashboard name could be claimed non-deterministically by an
    // unrelated manifest entry on the next `broods deploy`.
    const duplicate = await ctx.db
      .query("agentPolicies")
      .withIndex("by_stageId_and_name", (q) =>
        q.eq("stageId", args.stageId).eq("name", args.name.trim()),
      )
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (duplicate)
      throw new Error(
        `A policy named "${args.name.trim()}" already exists in this stage.`,
      );

    const document = normalizePolicyDocument(args.document);
    const now = Date.now();

    return await ctx.db.insert("agentPolicies", {
      accountId: account._id,
      projectId: args.projectId,
      stageId: args.stageId,
      name: args.name.trim(),
      description: args.description?.trim() || undefined,
      document: document,
      status: "active",
      managedBy: "dashboard",
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Internal create path used by account-manage in Convex storage mode.
 * @param args policy fields
 * @returns created policy id
 */
export const createInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    name: v.string(),
    description: v.optional(v.string()),
    document: v.any(),
    projectId: v.optional(v.id("projects")),
    stageId: v.optional(v.id("stages")),
    managedBy: v.optional(v.union(v.literal("cli"), v.literal("dashboard"))),
  },
  returns: v.id("agentPolicies"),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account) throw new Error(`Account not found: ${args.accountId}`);
    const document = normalizePolicyDocument(args.document);
    const now = Date.now();

    return await ctx.db.insert("agentPolicies", {
      accountId: args.accountId,
      projectId: args.projectId,
      stageId: args.stageId,
      name: args.name,
      description: args.description,
      document: document,
      status: "active",
      managedBy: args.managedBy,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/**
 * Internal lookup by account and runtime policy id.
 * @param accountId owning account
 * @param policyId policy id
 * @returns active policy or null
 */
export const getById = internalQuery({
  args: { accountId: v.id("accounts"), policyId: v.string() },
  returns: v.union(policyDoc, v.null()),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("agentPolicies", args.policyId);
    if (!normalized) return null;
    const policy = await ctx.db.get(normalized);
    if (
      !policy ||
      policy.accountId !== args.accountId ||
      policy.status !== "active"
    )
      return null;

    return policy;
  },
});

/**
 * Internal list of active policies for an account.
 * @param accountId owning account
 * @returns active policies
 */
export const list = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.array(policyDoc),
  handler: async (ctx, args) => {
    return await ctx.db
      .query("agentPolicies")
      .withIndex("by_accountId_and_status", (q) =>
        q.eq("accountId", args.accountId).eq("status", "active"),
      )
      .collect();
  },
});

/**
 * Lists active policies for a project stage.
 * @param projectId project containing the policies
 * @param stageId stage containing the policies
 * @returns active policy documents
 */
export const listForStage = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.array(policyDoc),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, args.projectId);
    if (!project) throw new Error("Project not found.");
    const stage = await getOwnedStage(ctx, user.id, args.stageId);
    if (!stage || stage.projectId !== args.projectId)
      throw new Error("Stage not found.");

    // Status leads the range: deletes are soft, so the name-only index range
    // accumulates tombstones this reactive query would re-read forever.
    return await ctx.db
      .query("agentPolicies")
      .withIndex("by_stageId_and_status_and_name", (q) =>
        q.eq("stageId", args.stageId).eq("status", "active"),
      )
      .collect();
  },
});

/**
 * Validates a policy document's shape before persisting.
 * Exported so CLI sync writes go through the same gate as CRUD mutations.
 * @param value candidate policy document
 * @returns the validated document
 * @throws when version, rules, effects, or actions are malformed
 */
export function normalizePolicyDocument(value: unknown): unknown {
  if (!isPlainObject(value))
    throw new Error("Policy document must be an object.");
  if (value.version !== 1)
    throw new Error("Policy document version must be 1.");
  if (!Array.isArray(value.rules))
    throw new Error("Policy document rules must be an array.");
  for (const [index, rule] of value.rules.entries()) {
    if (!isPlainObject(rule))
      throw new Error(`Policy rule ${index + 1} must be an object.`);
    if (rule.effect !== "allow" && rule.effect !== "deny") {
      throw new Error(`Policy rule ${index + 1} effect must be allow or deny.`);
    }
    if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
      throw new Error(
        `Policy rule ${index + 1} actions must be a non-empty array.`,
      );
    }
    for (const action of rule.actions) {
      if (typeof action !== "string" || !POLICY_ACTION_SET.has(action)) {
        throw new Error(
          `Policy rule ${index + 1} contains an unsupported action.`,
        );
      }
    }
  }

  return value;
}

/**
 * Soft-deletes a dashboard-owned policy.
 * @param policyId policy to delete
 * @returns deleted policy id
 */
export const remove = mutation({
  args: { policyId: v.id("agentPolicies") },
  returns: v.id("agentPolicies"),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const policy = await requireEditablePolicy(ctx, user.id, args.policyId);
    if (policy.managedBy === "cli") {
      throw new Error(
        "This policy is managed by code. Remove it from your project and run `broods deploy --prune`.",
      );
    }
    await ctx.db.patch(args.policyId, {
      status: "deleted",
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return args.policyId;
  },
});

/** Soft-deletes an internal account policy. */
export const removeInternal = internalMutation({
  args: { accountId: v.id("accounts"), policyId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("agentPolicies", args.policyId);
    if (!normalized)
      throw new Error("Policy does not belong to the supplied accountId");
    const policy = await ctx.db.get(normalized);
    if (!policy || policy.accountId !== args.accountId) {
      throw new Error("Policy does not belong to the supplied accountId");
    }
    await ctx.db.patch(normalized, {
      status: "deleted",
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Updates a dashboard-owned policy.
 * @param args policy patch
 * @returns updated policy id
 */
export const update = mutation({
  args: {
    policyId: v.id("agentPolicies"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    document: v.optional(v.any()),
  },
  returns: v.id("agentPolicies"),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const policy = await requireEditablePolicy(ctx, user.id, args.policyId);
    const document =
      args.document !== undefined
        ? normalizePolicyDocument(args.document)
        : undefined;
    await ctx.db.patch(args.policyId, {
      ...(args.name !== undefined ? { name: args.name.trim() } : {}),
      ...(args.description !== undefined
        ? { description: args.description?.trim() || undefined }
        : {}),
      ...(document !== undefined ? { document: document } : {}),
      updatedAt: Date.now(),
    });

    return policy._id;
  },
});

/**
 * Internal update path used by account-manage in Convex storage mode.
 * @param args policy patch
 * @returns null
 */
export const updateInternal = internalMutation({
  args: {
    accountId: v.id("accounts"),
    policyId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    document: v.optional(v.any()),
    status: v.optional(policyStatusValidator),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const normalized = ctx.db.normalizeId("agentPolicies", args.policyId);
    if (!normalized)
      throw new Error("Policy does not belong to the supplied accountId");
    const policy = await ctx.db.get(normalized);
    if (!policy || policy.accountId !== args.accountId) {
      throw new Error("Policy does not belong to the supplied accountId");
    }
    const document =
      args.document !== undefined
        ? normalizePolicyDocument(args.document)
        : undefined;
    await ctx.db.patch(normalized, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.description !== undefined
        ? { description: args.description ?? undefined }
        : {}),
      ...(document !== undefined ? { document: document } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      updatedAt: Date.now(),
    });

    return null;
  },
});

/**
 * Counts how many agent configs in a stage reference each policy.
 * Policy assignments live in `extraConfig.policy.policyIds` on `agentConfigs`.
 * @param projectId project containing the agents
 * @param stageId stage containing the agents
 * @returns record mapping policy id to the number of agents referencing it
 */
export const usageCounts = query({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.record(v.string(), v.number()),
  handler: async (ctx, args) => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await getProjectForRole(ctx, user.id, args.projectId);
    if (!project) throw new Error("Project not found.");
    const stage = await getOwnedStage(ctx, user.id, args.stageId);
    if (!stage || stage.projectId !== args.projectId)
      throw new Error("Stage not found.");

    const agents = await ctx.db
      .query("agentConfigs")
      .withIndex("by_projectId_and_stageId", (q) =>
        q.eq("projectId", args.projectId).eq("stageId", args.stageId),
      )
      .collect();

    const counts: Record<string, number> = {};
    for (const agent of agents) {
      const extra = isPlainObject(agent.extraConfig) ? agent.extraConfig : {};
      const policy = isPlainObject(extra.policy) ? extra.policy : {};
      const policyIds = Array.isArray(policy.policyIds) ? policy.policyIds : [];
      for (const policyId of policyIds) {
        if (typeof policyId === "string") {
          counts[policyId] = (counts[policyId] ?? 0) + 1;
        }
      }
    }

    return counts;
  },
});

async function requireEditablePolicy(
  ctx: Parameters<typeof getProjectForRole>[0],
  authId: string,
  policyId: Id<"agentPolicies">,
): Promise<Doc<"agentPolicies">> {
  const policy = await ctx.db.get(policyId);
  if (
    !policy ||
    policy.status !== "active" ||
    !policy.projectId ||
    !policy.stageId
  ) {
    throw new Error("Policy not found.");
  }
  const project = await getProjectForRole(
    ctx,
    authId,
    policy.projectId,
    "admin",
  );
  if (!project) throw new Error("Policy not found.");
  const stage = await getOwnedStage(ctx, authId, policy.stageId);
  if (!stage || stage.projectId !== policy.projectId)
    throw new Error("Policy not found.");

  return policy;
}
