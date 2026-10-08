/**
 * Organization › Access: permissions, policies and roles, all owned by the
 * org so one policy serves any agent, role or key in it.
 *
 * A permission names one thing an agent or member may do: the built-in
 * action vocabulary, or a custom name the org adds. A policy is named rules
 * over permissions, each in one scope, optionally narrowed by a condition.
 * A role is a named set of policies; a member gets one role. Owners and
 * admins may change all of it; `access:write` lets a custom role do so too.
 */

import { v, type Infer } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import {
  hasDashboardPermission,
  viewerDashboardPermissions,
} from "./model/access";
import { randomToken } from "./model/accountSecrets";
import { ClientError } from "./model/clientError";
import { assertPolicyUnreferenced } from "./model/policyReferences";
import {
  AGENT_POLICY_ACTIONS,
  API_POLICY_ACTIONS,
  DASHBOARD_POLICY_ACTIONS,
  type DashboardPolicyAction,
  type PolicyCondition,
  type PolicyDocument,
  type PolicyRule,
} from "./model/policyRules";
import { getActiveCaller } from "./org/orgs";

const OPERATOR_WORD: Record<PolicyCondition["operator"], string> = {
  equals: "=",
  notEquals: "≠",
  in: "in",
  notIn: "not in",
  prefix: "starts with",
  contains: "contains",
};

const AGENT_DESCRIPTIONS: Record<
  (typeof AGENT_POLICY_ACTIONS)[number],
  string
> = {
  "agent.invoke": "Address the agent at all",
  "tool.call": "Call a tool",
  "workspace.read": "Read workspace files",
  "workspace.write": "Write workspace files",
  "workspace.exec": "Run commands in the workspace",
  "subagent.run": "Run a subagent",
  "skill.load": "Load a skill",
};

const DASHBOARD_DESCRIPTIONS: Record<DashboardPolicyAction, string> = {
  "keys:read": "See keys",
  "keys:write": "Make, rotate and revoke keys",
  "members:write": "Change members and their roles",
  "access:write": "Change permissions, policies and roles",
  "billing:read": "See billing",
};

/** The built-in permissions, one line each. */
const BUILT_IN: Array<{ name: string; resource: string; description: string }> =
  [
    ...AGENT_POLICY_ACTIONS.map((name) => ({
      name: name,
      resource: "agent",
      description: AGENT_DESCRIPTIONS[name],
    })),
    ...API_POLICY_ACTIONS.map((name) => ({
      name: name,
      resource: name.split(":")[0] ?? "api",
      description: `${name.endsWith(":read") ? "Read" : "Change"} ${name.split(":")[0]} over the API`,
    })),
    ...DASHBOARD_POLICY_ACTIONS.map((name) => ({
      name: name,
      resource: "dashboard",
      description: DASHBOARD_DESCRIPTIONS[name],
    })),
  ];

const CONDITION_OPERATORS = [
  "equals",
  "notEquals",
  "in",
  "notIn",
  "prefix",
  "contains",
] as const;

const actorValidator = v.object({
  name: v.string(),
  avatarUrl: v.optional(v.string()),
});

const conditionValidator = v.object({
  attribute: v.string(),
  operator: v.union(...CONDITION_OPERATORS.map((op) => v.literal(op))),
  value: v.string(),
});

/** Where a rule applies: the whole org, one project, or one stage. */
const scopeValidator = v.object({
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
});

const permissionRowValidator = v.object({
  _id: v.optional(v.id("permissions")),
  name: v.string(),
  description: v.string(),
  resource: v.string(),
  kind: v.union(v.literal("built-in"), v.literal("custom")),
  createdAt: v.optional(v.number()),
  createdBy: v.optional(actorValidator),
});

const ruleRowValidator = v.object({
  id: v.string(),
  effect: v.union(v.literal("allow"), v.literal("deny")),
  permissions: v.array(v.string()),
  scope: v.string(),
  condition: v.optional(v.string()),
});

const policyRowValidator = v.object({
  _id: v.id("agentPolicies"),
  name: v.string(),
  description: v.optional(v.string()),
  mode: v.union(v.literal("audit"), v.literal("enforce")),
  scope: v.string(),
  managedBy: v.optional(v.string()),
  rules: v.array(ruleRowValidator),
  createdAt: v.number(),
  createdBy: v.optional(actorValidator),
});

const roleRowValidator = v.object({
  _id: v.optional(v.id("orgRoles")),
  name: v.string(),
  description: v.string(),
  kind: v.union(v.literal("built-in"), v.literal("custom")),
  policyIds: v.array(v.id("agentPolicies")),
  members: v.array(actorValidator),
  createdAt: v.optional(v.number()),
  createdBy: v.optional(actorValidator),
});

export type PermissionRow = Infer<typeof permissionRowValidator>;
export type PolicyRow = Infer<typeof policyRowValidator>;
export type RoleRow = Infer<typeof roleRowValidator>;

type Ctx = QueryCtx | MutationCtx;

/** What the signed-in member may do in the active org's dashboard. */
export const viewerPermissions = query({
  args: {},
  returns: v.array(v.string()),
  handler: async (ctx): Promise<DashboardPolicyAction[]> => {
    const caller = await getActiveCaller(ctx);
    if (!caller) return [];
    const orgId = ctx.db.normalizeId("orgs", caller.account.orgId);
    if (!orgId) return [];

    return await viewerDashboardPermissions(ctx, orgId, caller.user);
  },
});

/** Built-in permissions first, then the org's custom ones. */
export const listPermissions = query({
  args: {},
  returns: v.array(permissionRowValidator),
  handler: async (ctx): Promise<PermissionRow[]> => {
    const caller = await getActiveCaller(ctx);
    if (!caller) return [];
    const custom = await ctx.db
      .query("permissions")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", caller.account._id),
      )
      .collect();

    return [
      ...BUILT_IN.map((entry) => ({ ...entry, kind: "built-in" as const })),
      ...(await Promise.all(
        custom.map(async (row) => ({
          _id: row._id,
          name: row.name,
          description: row.description ?? "",
          resource: row.resource,
          kind: "custom" as const,
          createdAt: row.createdAt,
          createdBy: await actorOf(ctx, row.createdBy),
        })),
      )),
    ];
  },
});

export const createPermission = mutation({
  args: {
    name: v.string(),
    resource: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("permissions"),
  handler: async (ctx, args): Promise<Id<"permissions">> => {
    const caller = await requireAccessWriter(ctx);
    const name = args.name.trim();
    if (!/^[a-z][a-z0-9_.:-]{2,80}$/.test(name)) {
      throw new ClientError(
        "A permission name is lowercase letters, digits, dots, dashes or colons",
      );
    }
    if (BUILT_IN.some((entry) => entry.name === name)) {
      throw new ClientError(`${name} is a built-in permission`);
    }
    const existing = await ctx.db
      .query("permissions")
      .withIndex("by_accountId_and_name", (q) =>
        q.eq("accountId", caller.account._id).eq("name", name),
      )
      .unique();
    if (existing) throw new ClientError(`${name} already exists`);
    const now = Date.now();

    return await ctx.db.insert("permissions", {
      accountId: caller.account._id,
      name: name,
      description: args.description?.trim() || undefined,
      resource: args.resource.trim() || "custom",
      createdBy: caller.user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const removePermission = mutation({
  args: { permissionId: v.id("permissions") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await requireAccessWriter(ctx);
    const row = await ctx.db.get(args.permissionId);
    if (!row || row.accountId !== caller.account._id) {
      throw new ClientError("Permission not found");
    }
    const policies = await accountPolicies(ctx, caller.account._id);
    const used = policies.find((policy) =>
      (policy.document as PolicyDocument).rules.some((rule) =>
        rule.actions.includes(row.name),
      ),
    );
    if (used) {
      throw new ClientError(
        `${row.name} is used by the policy "${used.name}"; remove that rule first`,
      );
    }
    await ctx.db.delete(args.permissionId);

    return null;
  },
});

/** Every active policy the org owns, org-wide ones and stage ones alike. */
export const listPolicies = query({
  args: {},
  returns: v.array(policyRowValidator),
  handler: async (ctx): Promise<PolicyRow[]> => {
    const caller = await getActiveCaller(ctx);
    if (!caller) return [];
    const policies = await accountPolicies(ctx, caller.account._id);

    return await Promise.all(policies.map((policy) => policyRow(ctx, policy)));
  },
});

export const createPolicy = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    mode: v.union(v.literal("audit"), v.literal("enforce")),
  },
  returns: v.id("agentPolicies"),
  handler: async (ctx, args): Promise<Id<"agentPolicies">> => {
    const caller = await requireAccessWriter(ctx);
    const name = args.name.trim();
    if (!name) throw new ClientError("A policy needs a name");
    const document: PolicyDocument = { version: 1, mode: args.mode, rules: [] };
    const now = Date.now();

    return await ctx.db.insert("agentPolicies", {
      accountId: caller.account._id,
      name: name,
      description: args.description?.trim() || undefined,
      document: document,
      status: "active",
      managedBy: "dashboard",
      createdBy: caller.user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updatePolicy = mutation({
  args: {
    policyId: v.id("agentPolicies"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    mode: v.optional(v.union(v.literal("audit"), v.literal("enforce"))),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await requireAccessWriter(ctx);
    const policy = await ownedPolicy(ctx, caller.account._id, args.policyId);
    const document = policy.document as PolicyDocument;
    await ctx.db.patch(policy._id, {
      ...(args.name !== undefined ? { name: args.name.trim() } : {}),
      ...(args.description !== undefined
        ? { description: args.description?.trim() || undefined }
        : {}),
      ...(args.mode !== undefined
        ? { document: { ...document, mode: args.mode } }
        : {}),
      updatedAt: Date.now(),
    });

    return null;
  },
});

/** One permission in one scope, optionally narrowed by a condition. */
export const addRule = mutation({
  args: {
    policyId: v.id("agentPolicies"),
    permission: v.string(),
    effect: v.optional(v.union(v.literal("allow"), v.literal("deny"))),
    scope: scopeValidator,
    condition: v.optional(conditionValidator),
  },
  returns: v.string(),
  handler: async (ctx, args): Promise<string> => {
    const caller = await requireAccessWriter(ctx);
    const policy = await ownedPolicy(ctx, caller.account._id, args.policyId);
    const known = await permissionNames(ctx, caller.account._id);
    if (!known.has(args.permission)) {
      throw new ClientError(`${args.permission} is not a permission`);
    }
    const conditions: PolicyCondition[] = [];
    if (args.scope.projectId) {
      conditions.push({
        attribute: "project.id",
        operator: "equals",
        value: args.scope.projectId,
      });
    }
    if (args.scope.stageId) {
      conditions.push({
        attribute: "stage.id",
        operator: "equals",
        value: args.scope.stageId,
      });
    }
    if (args.condition) {
      conditions.push({
        attribute: args.condition.attribute.trim(),
        operator: args.condition.operator,
        value: args.condition.value.trim(),
      });
    }
    const rule: PolicyRule = {
      id: randomToken("rule_", 6),
      effect: args.effect ?? "allow",
      actions: [args.permission],
      ...(conditions.length > 0 ? { conditions: conditions } : {}),
    };
    const document = policy.document as PolicyDocument;
    await ctx.db.patch(policy._id, {
      document: { ...document, rules: [...document.rules, rule] },
      updatedAt: Date.now(),
    });

    return rule.id;
  },
});

export const removeRule = mutation({
  args: { policyId: v.id("agentPolicies"), ruleId: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await requireAccessWriter(ctx);
    const policy = await ownedPolicy(ctx, caller.account._id, args.policyId);
    const document = policy.document as PolicyDocument;
    await ctx.db.patch(policy._id, {
      document: {
        ...document,
        rules: document.rules.filter((rule) => rule.id !== args.ruleId),
      },
      updatedAt: Date.now(),
    });

    return null;
  },
});

/** Soft-deletes a policy no agent, role or key still names. */
export const removePolicy = mutation({
  args: { policyId: v.id("agentPolicies") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await requireAccessWriter(ctx);
    const policy = await ownedPolicy(ctx, caller.account._id, args.policyId);
    if (policy.managedBy === "cli") {
      throw new ClientError(
        "This policy is managed by code. Remove it from your project and run `broods deploy --prune`.",
      );
    }
    const orgId = orgIdOf(ctx, caller.account);
    const roles = orgId ? await orgRoles(ctx, orgId) : [];
    const holder = roles.find((role) => role.policyIds.includes(policy._id));
    if (holder) {
      throw new ClientError(
        `The role "${holder.name}" holds this policy; detach it first`,
      );
    }
    await assertPolicyUnreferenced(ctx, policy);
    const now = Date.now();
    await ctx.db.patch(policy._id, {
      status: "deleted",
      deletedAt: now,
      updatedAt: now,
    });

    return null;
  },
});

/** Built-in roles first, then the org's custom ones, each with its members. */
export const listRoles = query({
  args: {},
  returns: v.array(roleRowValidator),
  handler: async (ctx): Promise<RoleRow[]> => {
    const caller = await getActiveCaller(ctx);
    if (!caller) return [];
    const orgId = orgIdOf(ctx, caller.account);
    if (!orgId) return [];
    const memberships = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", orgId))
      .collect();
    const membersOf = async (
      pick: (membership: Doc<"orgMembers">) => boolean,
    ): Promise<RoleRow["members"]> => {
      const rows = await Promise.all(
        memberships
          .filter(pick)
          .map((membership) => actorOf(ctx, membership.userId)),
      );

      return rows.filter((row): row is NonNullable<typeof row> => !!row);
    };
    const builtIn: RoleRow[] = [
      {
        name: "Owner",
        description: "Everything, including deleting the organization",
        kind: "built-in",
        policyIds: [],
        members: await membersOf((m) => m.role === "owner"),
      },
      {
        name: "Admin",
        description: "Everything but deleting the organization",
        kind: "built-in",
        policyIds: [],
        members: await membersOf((m) => m.role === "admin"),
      },
      {
        name: "Member",
        description: "Reads everything, changes nothing",
        kind: "built-in",
        policyIds: [],
        members: await membersOf((m) => m.role === "member" && !m.roleId),
      },
    ];
    const custom = await Promise.all(
      (await orgRoles(ctx, orgId)).map(async (role): Promise<RoleRow> => ({
        _id: role._id,
        name: role.name,
        description: role.description ?? "",
        kind: "custom",
        policyIds: role.policyIds,
        members: await membersOf((m) => m.roleId === role._id),
        createdAt: role.createdAt,
        createdBy: await actorOf(ctx, role.createdBy),
      })),
    );

    return [...builtIn, ...custom];
  },
});

export const createRole = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    policyIds: v.array(v.id("agentPolicies")),
  },
  returns: v.id("orgRoles"),
  handler: async (ctx, args): Promise<Id<"orgRoles">> => {
    const caller = await requireAccessWriter(ctx);
    const orgId = orgIdOf(ctx, caller.account);
    if (!orgId) throw new ClientError("No organization");
    const name = args.name.trim();
    if (!name) throw new ClientError("A role needs a name");
    if (["owner", "admin", "member"].includes(name.toLowerCase())) {
      throw new ClientError(`${name} is a built-in role`);
    }
    await assertOwnedPolicies(ctx, caller.account._id, args.policyIds);
    const now = Date.now();

    return await ctx.db.insert("orgRoles", {
      orgId: orgId,
      name: name,
      description: args.description?.trim() || undefined,
      policyIds: args.policyIds,
      createdBy: caller.user._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const updateRole = mutation({
  args: {
    roleId: v.id("orgRoles"),
    name: v.optional(v.string()),
    description: v.optional(v.union(v.string(), v.null())),
    policyIds: v.optional(v.array(v.id("agentPolicies"))),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await requireAccessWriter(ctx);
    const role = await ownedRole(ctx, caller.account, args.roleId);
    if (args.policyIds) {
      await assertOwnedPolicies(ctx, caller.account._id, args.policyIds);
    }
    await ctx.db.patch(role._id, {
      ...(args.name !== undefined ? { name: args.name.trim() } : {}),
      ...(args.description !== undefined
        ? { description: args.description?.trim() || undefined }
        : {}),
      ...(args.policyIds !== undefined ? { policyIds: args.policyIds } : {}),
      updatedAt: Date.now(),
    });

    return null;
  },
});

/** Deletes a role nobody holds. */
export const removeRole = mutation({
  args: { roleId: v.id("orgRoles") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const caller = await requireAccessWriter(ctx);
    const role = await ownedRole(ctx, caller.account, args.roleId);
    const holder = await ctx.db
      .query("orgMembers")
      .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", role.orgId))
      .filter((q) => q.eq(q.field("roleId"), role._id))
      .first();
    if (holder) {
      throw new ClientError(
        "A member holds this role; give them another first",
      );
    }
    await ctx.db.delete(role._id);

    return null;
  },
});

/** The caller, who must hold `access:write` in the active org. */
async function requireAccessWriter(
  ctx: MutationCtx,
): Promise<NonNullable<Awaited<ReturnType<typeof getActiveCaller>>>> {
  const authUser = await authKit.getAuthUser(ctx);
  if (!authUser) throw new Error("User not found or not authenticated");
  const caller = await getActiveCaller(ctx);
  const orgId = caller ? orgIdOf(ctx, caller.account) : null;
  if (
    !caller ||
    !orgId ||
    !(await hasDashboardPermission(ctx, orgId, caller.user, "access:write"))
  ) {
    throw new ClientError("No permission to change access", "unauthorized");
  }

  return caller;
}

async function accountPolicies(
  ctx: Ctx,
  accountId: Id<"accounts">,
): Promise<Doc<"agentPolicies">[]> {
  return await ctx.db
    .query("agentPolicies")
    .withIndex("by_accountId_and_status", (q) =>
      q.eq("accountId", accountId).eq("status", "active"),
    )
    .collect();
}

async function ownedPolicy(
  ctx: Ctx,
  accountId: Id<"accounts">,
  policyId: Id<"agentPolicies">,
): Promise<Doc<"agentPolicies">> {
  const policy = await ctx.db.get(policyId);
  if (!policy || policy.accountId !== accountId || policy.status !== "active") {
    throw new ClientError("Policy not found");
  }

  return policy;
}

async function assertOwnedPolicies(
  ctx: Ctx,
  accountId: Id<"accounts">,
  policyIds: readonly Id<"agentPolicies">[],
): Promise<void> {
  for (const policyId of policyIds) await ownedPolicy(ctx, accountId, policyId);
}

async function orgRoles(
  ctx: Ctx,
  orgId: Id<"orgs">,
): Promise<Doc<"orgRoles">[]> {
  return await ctx.db
    .query("orgRoles")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();
}

async function ownedRole(
  ctx: Ctx,
  account: Doc<"accounts">,
  roleId: Id<"orgRoles">,
): Promise<Doc<"orgRoles">> {
  const role = await ctx.db.get(roleId);
  if (!role || role.orgId !== orgIdOf(ctx, account)) {
    throw new ClientError("Role not found");
  }

  return role;
}

/** Every permission name a rule may use: built-in and the org's custom ones. */
async function permissionNames(
  ctx: Ctx,
  accountId: Id<"accounts">,
): Promise<Set<string>> {
  const custom = await ctx.db
    .query("permissions")
    .withIndex("by_accountId_and_name", (q) => q.eq("accountId", accountId))
    .collect();

  return new Set([
    ...BUILT_IN.map((entry) => entry.name),
    ...custom.map((row) => row.name),
  ]);
}

/** A policy as the list draws it: its rules in words, its scope, who made it. */
async function policyRow(
  ctx: Ctx,
  policy: Doc<"agentPolicies">,
): Promise<PolicyRow> {
  const document = policy.document as PolicyDocument;
  const stage = policy.stageId ? await ctx.db.get(policy.stageId) : null;

  return {
    _id: policy._id,
    name: policy.name,
    description: policy.description,
    mode: document.mode ?? "audit",
    scope: stage ? `stage ${stage.name}` : "organization",
    managedBy: policy.managedBy,
    rules: await Promise.all(
      document.rules.map(async (rule) => ({
        id: rule.id,
        effect: rule.effect,
        permissions: rule.actions,
        scope: await ruleScope(ctx, rule),
        condition: ruleCondition(rule),
      })),
    ),
    createdAt: policy.createdAt,
    createdBy: await actorOf(ctx, policy.createdBy),
  };
}

/** "organization", "project demo-app" or "stage demo-app / production". */
async function ruleScope(ctx: Ctx, rule: PolicyRule): Promise<string> {
  const stageId = conditionValue(rule, "stage.id");
  const projectId = conditionValue(rule, "project.id");
  const stage = stageId
    ? await ctx.db.get(ctx.db.normalizeId("stages", stageId)!)
    : null;
  if (stage) {
    const project = await ctx.db.get(stage.projectId);

    return `stage ${project ? `${project.name} / ` : ""}${stage.name}`;
  }
  const project = projectId
    ? await ctx.db.get(ctx.db.normalizeId("projects", projectId)!)
    : null;

  return project ? `project ${project.name}` : "organization";
}

/** The rule's conditions that are not its scope, in one line. */
function ruleCondition(rule: PolicyRule): string | undefined {
  const others = (rule.conditions ?? []).filter(
    (condition) =>
      condition.attribute !== "stage.id" &&
      condition.attribute !== "project.id",
  );
  if (others.length === 0) return undefined;

  return others
    .map(
      (condition) =>
        `${condition.attribute} ${OPERATOR_WORD[condition.operator]} ${String(condition.value)}`,
    )
    .join(", ");
}

function conditionValue(rule: PolicyRule, attribute: string): string | null {
  const match = (rule.conditions ?? []).find(
    (condition) =>
      condition.attribute === attribute && condition.operator === "equals",
  );

  return match && typeof match.value === "string" ? match.value : null;
}

function orgIdOf(ctx: Ctx, account: Doc<"accounts">): Id<"orgs"> | null {
  return ctx.db.normalizeId("orgs", account.orgId);
}

/** A user id as the name and avatar a list draws; undefined when unknown. */
async function actorOf(
  ctx: Ctx,
  userId: Id<"users"> | undefined,
): Promise<Infer<typeof actorValidator> | undefined> {
  if (!userId) return undefined;
  const user = await ctx.db.get(userId);

  return user ? { name: user.name, avatarUrl: user.avatarUrl } : undefined;
}
