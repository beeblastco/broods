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
import {
  activePolicies,
  assertGrantsWithinReach,
  dashboardPermissions,
  memberAccess,
  requireDashboardPermission,
  tierPermissions,
  type ScopedPolicy,
} from "./model/access";
import { randomToken } from "./model/accountSecrets";
import { actorsOf, actorValidator, type Actor } from "./model/actor";
import { ClientError } from "./model/clientError";
import { orgIdOf } from "./model/ownership/org";
import { assertPolicyUnreferenced } from "./model/policyReferences";
import {
  AGENT_POLICY_ACTIONS,
  API_POLICY_ACTIONS,
  DASHBOARD_DESCRIPTIONS,
  DASHBOARD_POLICY_ACTIONS,
  POLICY_CONDITION_OPERATORS,
  type DashboardPolicyAction,
  type PolicyCondition,
  type PolicyDocument,
  type PolicyRule,
} from "./model/policyRules";
import { getActiveCaller, type ActiveAccount } from "./org/orgs";

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

/** The built-in permissions, one line each. */
const BUILT_IN: Array<{
  kind: "built-in";
  name: string;
  resource: string;
  description: string;
}> = [
  ...AGENT_POLICY_ACTIONS.map((name) => ({
    kind: "built-in" as const,
    name: name,
    resource: "agent",
    description: AGENT_DESCRIPTIONS[name],
  })),
  ...API_POLICY_ACTIONS.map((name) => ({
    kind: "built-in" as const,
    name: name,
    resource: name.split(":")[0] ?? "api",
    description: `${name.endsWith(":read") ? "Read" : "Change"} ${name.split(":")[0]} over the API`,
  })),
  ...DASHBOARD_POLICY_ACTIONS.map((name) => ({
    kind: "built-in" as const,
    name: name,
    resource: "dashboard",
    description: DASHBOARD_DESCRIPTIONS[name],
  })),
];

const BUILT_IN_ROLE_NAMES = ["owner", "admin", "member"];

const dashboardActionValidator = v.union(
  ...DASHBOARD_POLICY_ACTIONS.map((action) => v.literal(action)),
);

const conditionValidator = v.object({
  attribute: v.string(),
  operator: v.union(
    ...POLICY_CONDITION_OPERATORS.map((operator) => v.literal(operator.value)),
  ),
  value: v.string(),
});

/** Where a rule applies: the whole org, one project, or one stage. */
const scopeValidator = v.object({
  projectId: v.optional(v.id("projects")),
  stageId: v.optional(v.id("stages")),
});

const permissionRowValidator = v.union(
  v.object({
    kind: v.literal("built-in"),
    name: v.string(),
    description: v.string(),
    resource: v.string(),
  }),
  v.object({
    kind: v.literal("custom"),
    _id: v.id("permissions"),
    name: v.string(),
    description: v.string(),
    resource: v.string(),
    createdAt: v.number(),
    createdBy: v.optional(actorValidator),
  }),
);

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
  /** The distinct permissions across the rules, for counts and summaries. */
  permissions: v.array(v.string()),
  createdAt: v.number(),
  createdBy: v.optional(actorValidator),
});

const roleFields = {
  name: v.string(),
  description: v.string(),
  policyIds: v.array(v.id("agentPolicies")),
  members: v.array(actorValidator),
  /** The dashboard permissions the role grants org-wide. */
  permissions: v.array(dashboardActionValidator),
};

const roleRowValidator = v.union(
  v.object({ kind: v.literal("built-in"), ...roleFields }),
  v.object({
    kind: v.literal("custom"),
    _id: v.id("orgRoles"),
    createdAt: v.number(),
    createdBy: v.optional(actorValidator),
    ...roleFields,
  }),
);

type PermissionRow = Infer<typeof permissionRowValidator>;
type PolicyRow = Infer<typeof policyRowValidator>;
type RoleRow = Infer<typeof roleRowValidator>;

type Ctx = QueryCtx | MutationCtx;

/** What the signed-in member may do in the active org's dashboard, org-wide or in one project. */
export const viewerPermissions = query({
  args: { projectId: v.optional(v.id("projects")) },
  returns: v.array(dashboardActionValidator),
  handler: async (ctx, args): Promise<DashboardPolicyAction[]> => {
    const caller = await getActiveCaller(ctx);
    if (!caller) return [];
    const orgId = orgIdOf(ctx, caller.account);
    if (!orgId) return [];
    const access = await memberAccess(ctx, orgId, caller.user);
    if (!access) return [];

    return dashboardPermissions(access, { projectId: args.projectId });
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
    const creators = await actorsOf(
      ctx,
      custom.map((row) => row.createdBy),
    );

    return [
      ...BUILT_IN,
      ...custom.map((row): PermissionRow => ({
        kind: "custom",
        _id: row._id,
        name: row.name,
        description: row.description ?? "",
        resource: row.resource,
        createdAt: row.createdAt,
        createdBy: row.createdBy ? creators.get(row.createdBy) : undefined,
      })),
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
      policy.document.rules.some((rule) => rule.actions.includes(row.name)),
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
    const names = await scopeNames(ctx, policies);
    const creators = await actorsOf(
      ctx,
      policies.map((policy) => policy.createdBy),
    );

    return policies.map((policy) => policyRow(policy, names, creators));
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
    const policy = await editablePolicy(ctx, caller.account._id, args.policyId);
    await ctx.db.patch(policy._id, {
      ...(args.name !== undefined ? { name: args.name.trim() } : {}),
      ...(args.description !== undefined
        ? { description: args.description?.trim() || undefined }
        : {}),
      ...(args.mode !== undefined
        ? { document: { ...policy.document, mode: args.mode } }
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
    const policy = await editablePolicy(ctx, caller.account._id, args.policyId);
    const known = await permissionNames(ctx, caller.account._id);
    if (!known.has(args.permission)) {
      throw new ClientError(`${args.permission} is not a permission`);
    }
    const dashboardAction = DASHBOARD_POLICY_ACTIONS.find(
      (action) => action === args.permission,
    );
    // The dashboard evaluator reads only the scope, so a condition on any
    // other attribute could neither grant nor refuse anything there.
    if (dashboardAction && args.condition) {
      throw new ClientError(
        "A dashboard permission takes only a project or stage scope",
      );
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
      const { operator } = args.condition;
      conditions.push({
        attribute: args.condition.attribute.trim(),
        operator: operator,
        // `in` and `notIn` compare against a list, typed comma-separated.
        value:
          operator === "in" || operator === "notIn"
            ? args.condition.value.split(",").map((entry) => entry.trim())
            : args.condition.value.trim(),
      });
    }
    const rule: PolicyRule = {
      id: randomToken("rule_", 6),
      effect: args.effect ?? "allow",
      actions: [args.permission],
      ...(conditions.length > 0 ? { conditions: conditions } : {}),
    };
    const document = {
      ...policy.document,
      rules: [...policy.document.rules, rule],
    };
    const orgId = orgIdOf(ctx, caller.account);
    if (orgId && dashboardAction && rule.effect === "allow") {
      await assertGrantsWithinReach(ctx, orgId, caller.user, [
        scoped(policy, document),
      ]);
    }
    await ctx.db.patch(policy._id, {
      document: document,
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
    const policy = await editablePolicy(ctx, caller.account._id, args.policyId);
    await ctx.db.patch(policy._id, {
      document: {
        ...policy.document,
        rules: policy.document.rules.filter((rule) => rule.id !== args.ruleId),
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
    const policy = await editablePolicy(ctx, caller.account._id, args.policyId);
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

/** Built-in roles first, then the org's custom ones, each with its members and permissions. */
export const listRoles = query({
  args: {},
  returns: v.array(roleRowValidator),
  handler: async (ctx): Promise<RoleRow[]> => {
    const caller = await getActiveCaller(ctx);
    if (!caller) return [];
    const orgId = orgIdOf(ctx, caller.account);
    if (!orgId) return [];
    const [memberships, roles] = await Promise.all([
      ctx.db
        .query("orgMembers")
        .withIndex("by_orgId_and_userId", (q) => q.eq("orgId", orgId))
        .collect(),
      orgRoles(ctx, orgId),
    ]);
    const people = await actorsOf(ctx, [
      ...memberships.map((membership) => membership.userId),
      ...roles.map((role) => role.createdBy),
    ]);
    const membersOf = (
      pick: (membership: Doc<"orgMembers">) => boolean,
    ): Actor[] =>
      memberships
        .filter(pick)
        .map((membership) => people.get(membership.userId))
        .filter((actor): actor is Actor => actor !== undefined);
    const builtIn: RoleRow[] = [
      {
        kind: "built-in",
        name: "Owner",
        description: "Everything, including deleting the organization",
        policyIds: [],
        members: membersOf((m) => m.role === "owner"),
        permissions: tierPermissions("owner"),
      },
      {
        kind: "built-in",
        name: "Admin",
        description: "Everything but deleting the organization",
        policyIds: [],
        members: membersOf((m) => m.role === "admin"),
        permissions: tierPermissions("admin"),
      },
      {
        kind: "built-in",
        name: "Member",
        description: "Reads everything, changes nothing",
        policyIds: [],
        members: membersOf((m) => m.role === "member" && !m.roleId),
        permissions: tierPermissions("member"),
      },
    ];
    const custom = await Promise.all(
      roles.map(async (role): Promise<RoleRow> => {
        const policies = await activePolicies(ctx, role.policyIds);

        return {
          kind: "custom",
          _id: role._id,
          name: role.name,
          description: role.description ?? "",
          policyIds: role.policyIds,
          members: membersOf((m) => m.roleId === role._id),
          permissions: dashboardPermissions({
            tier: "member",
            policies: policies,
          }),
          createdAt: role.createdAt,
          createdBy: role.createdBy ? people.get(role.createdBy) : undefined,
        };
      }),
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
    if (BUILT_IN_ROLE_NAMES.includes(name.toLowerCase())) {
      throw new ClientError(`${name} is a built-in role`);
    }
    await assertOwnedPolicies(ctx, caller.account._id, args.policyIds);
    await assertGrantsWithinReach(
      ctx,
      orgId,
      caller.user,
      await activePolicies(ctx, args.policyIds),
    );
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
      await assertGrantsWithinReach(
        ctx,
        role.orgId,
        caller.user,
        await activePolicies(ctx, args.policyIds),
      );
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
async function requireAccessWriter(ctx: MutationCtx): Promise<ActiveAccount> {
  const caller = await getActiveCaller(ctx);
  const orgId = caller ? orgIdOf(ctx, caller.account) : null;
  if (!caller || !orgId) {
    throw new ClientError("No permission for this", "unauthorized");
  }
  await requireDashboardPermission(ctx, orgId, caller.user, "access:write");

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

/** An owned policy the dashboard may change: one it made, not one `broods deploy` owns. */
async function editablePolicy(
  ctx: Ctx,
  accountId: Id<"accounts">,
  policyId: Id<"agentPolicies">,
): Promise<Doc<"agentPolicies">> {
  const policy = await ownedPolicy(ctx, accountId, policyId);
  if (policy.managedBy === "cli") {
    throw new ClientError(
      "This policy is managed by code. Change it in your project and run `broods deploy`.",
    );
  }

  return policy;
}

/** A policy row with the document it would hold, as the evaluator reads it. */
function scoped(
  policy: Doc<"agentPolicies">,
  document: PolicyDocument,
): ScopedPolicy {
  return {
    document: document,
    projectId: policy.projectId,
    stageId: policy.stageId,
  };
}

async function assertOwnedPolicies(
  ctx: Ctx,
  accountId: Id<"accounts">,
  policyIds: readonly Id<"agentPolicies">[],
): Promise<void> {
  await Promise.all(
    policyIds.map((policyId) => ownedPolicy(ctx, accountId, policyId)),
  );
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

/** The project and stage names the policies' scopes point at, each fetched once. */
async function scopeNames(
  ctx: Ctx,
  policies: readonly Doc<"agentPolicies">[],
): Promise<Map<string, string>> {
  const stageIds = new Set<Id<"stages">>();
  const projectIds = new Set<Id<"projects">>();
  for (const policy of policies) {
    if (policy.stageId) stageIds.add(policy.stageId);
    for (const rule of policy.document.rules) {
      const stageId = ctx.db.normalizeId(
        "stages",
        conditionValue(rule, "stage.id") ?? "",
      );
      const projectId = ctx.db.normalizeId(
        "projects",
        conditionValue(rule, "project.id") ?? "",
      );
      if (stageId) stageIds.add(stageId);
      if (projectId) projectIds.add(projectId);
    }
  }
  const stages = (
    await Promise.all([...stageIds].map((id) => ctx.db.get(id)))
  ).filter((stage) => stage !== null);
  for (const stage of stages) projectIds.add(stage.projectId);
  const projects = (
    await Promise.all([...projectIds].map((id) => ctx.db.get(id)))
  ).filter((project) => project !== null);
  const names = new Map<string, string>();
  for (const project of projects) {
    names.set(project._id, `project ${project.name}`);
  }
  for (const stage of stages) {
    const project = projects.find((entry) => entry._id === stage.projectId);
    names.set(
      stage._id,
      `stage ${project ? `${project.name} / ` : ""}${stage.name}`,
    );
  }

  return names;
}

/** A policy as the list draws it: its rules in words, its scope, who made it. */
function policyRow(
  policy: Doc<"agentPolicies">,
  names: Map<string, string>,
  creators: Map<Id<"users">, Actor>,
): PolicyRow {
  const rules = policy.document.rules;

  return {
    _id: policy._id,
    name: policy.name,
    description: policy.description,
    mode: policy.document.mode ?? "audit",
    scope: (policy.stageId && names.get(policy.stageId)) || "organization",
    managedBy: policy.managedBy,
    rules: rules.map((rule) => ({
      id: rule.id,
      effect: rule.effect,
      permissions: rule.actions,
      scope: ruleScope(rule, names),
      condition: ruleCondition(rule),
    })),
    permissions: [...new Set(rules.flatMap((rule) => rule.actions))],
    createdAt: policy.createdAt,
    createdBy: policy.createdBy ? creators.get(policy.createdBy) : undefined,
  };
}

/** "organization", "project demo-app" or "stage demo-app / production". */
function ruleScope(rule: PolicyRule, names: Map<string, string>): string {
  const scoped =
    conditionValue(rule, "stage.id") ?? conditionValue(rule, "project.id");

  return (scoped && names.get(scoped)) || "organization";
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
        `${condition.attribute} ${POLICY_CONDITION_OPERATORS.find((operator) => operator.value === condition.operator)?.label} ${String(condition.value)}`,
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
