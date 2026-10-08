/// <reference types="vite/client" />
/**
 * A custom role grants a member the dashboard permissions its policies allow,
 * a deny wins over an allow, and an admin holds everything by tier.
 */

import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { dashboardPermissions, policiesAllow } from "../model/access";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

let currentAuthId = "auth_owner";

vi.mock(
  "../auth",
  (): { authKit: { getAuthUser: () => Promise<{ id: string }> } } => ({
    authKit: {
      getAuthUser: async (): Promise<{ id: string }> => ({
        id: currentAuthId,
      }),
    },
  }),
);

test("policies grant and refuse in the same order core's OPA uses, where they are scoped", (): void => {
  const allow = {
    version: 1 as const,
    mode: "enforce" as const,
    rules: [{ id: "a", effect: "allow" as const, actions: ["keys:read"] }],
  };
  const deny = {
    version: 1 as const,
    mode: "enforce" as const,
    rules: [{ id: "d", effect: "deny" as const, actions: ["keys:read"] }],
  };
  const grant = { document: allow };
  const refuse = { document: deny };
  expect(policiesAllow([grant], "keys:read")).toBe(true);
  expect(policiesAllow([grant, refuse], "keys:read")).toBe(false);
  expect(policiesAllow([grant], "keys:write")).toBe(false);
  expect(
    policiesAllow([{ document: { ...allow, mode: "audit" } }], "keys:read"),
  ).toBe(false);
  expect(dashboardPermissions({ tier: "member", policies: [grant] })).toEqual([
    "keys:read",
  ]);
  expect(dashboardPermissions({ tier: "admin", policies: [] })).toContain(
    "access:write",
  );
});

test("a member with a custom role sees the keys its policy allows", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const seeded = await t.run(
    async (
      ctx,
    ): Promise<{
      orgId: Id<"orgs">;
      memberId: Id<"orgMembers">;
      accountId: Id<"accounts">;
    }> => {
      const now = Date.now();
      const orgId = await ctx.db.insert("orgs", {
        name: "beeblast",
        slug: "beeblast",
        ownerAuthId: "auth_owner",
        plan: "free",
        createdAt: now,
      });
      const ownerId = await ctx.db.insert("users", {
        authId: "auth_owner",
        email: "owner@example.com",
        name: "Owner",
        plan: "free",
        activeOrgId: orgId,
      });
      const memberUserId = await ctx.db.insert("users", {
        authId: "auth_member",
        email: "ada@example.com",
        name: "Ada",
        plan: "free",
        activeOrgId: orgId,
      });
      await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: ownerId,
        role: "owner",
        createdAt: now,
      });
      const memberId = await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: memberUserId,
        role: "member",
        createdAt: now,
      });
      const accountId = await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "beeblast",
        secretHash: "hash-beeblast",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      return { orgId: orgId, memberId: memberId, accountId: accountId };
    },
  );

  currentAuthId = "auth_member";
  expect(await t.query(api.access.viewerPermissions, {})).toEqual([]);
  expect(await t.query(api.apiKeys.listForOrg, {})).toBeNull();

  currentAuthId = "auth_owner";
  const policyId = await t.mutation(api.access.createPolicy, {
    name: "Read-only ops",
    mode: "enforce",
  });
  await t.mutation(api.access.addRule, {
    policyId: policyId,
    permission: "keys:read",
    scope: {},
  });
  const roleId = await t.mutation(api.access.createRole, {
    name: "Engineer",
    description: "Sees keys",
    policyIds: [policyId],
  });
  await t.mutation(api.org.members.updateRole, {
    membershipId: seeded.memberId,
    role: "member",
    roleId: roleId,
  });

  currentAuthId = "auth_member";
  expect(await t.query(api.access.viewerPermissions, {})).toEqual([
    "keys:read",
  ]);
  expect(await t.query(api.apiKeys.listForOrg, {})).not.toBeNull();
  await expect(
    t.mutation(api.access.createPermission, {
      name: "tool.stripe.refund",
      resource: "tool",
    }),
  ).rejects.toThrow(/No permission/);
  await expect(
    t.mutation(api.org.members.add, {
      orgId: seeded.orgId,
      email: "owner@example.com",
    }),
  ).rejects.toThrow(/No permission/);

  // A rule scoped to one project counts there and nowhere else.
  const [projectA, projectB] = await t.run(
    async (ctx): Promise<[Id<"projects">, Id<"projects">]> => [
      await ctx.db.insert("projects", {
        authId: "auth_owner",
        orgId: seeded.orgId,
        name: "a",
        slug: "a",
        updatedAt: Date.now(),
      }),
      await ctx.db.insert("projects", {
        authId: "auth_owner",
        orgId: seeded.orgId,
        name: "b",
        slug: "b",
        updatedAt: Date.now(),
      }),
    ],
  );
  currentAuthId = "auth_owner";
  await t.mutation(api.access.addRule, {
    policyId: policyId,
    permission: "keys:write",
    scope: { projectId: projectA },
  });
  currentAuthId = "auth_member";
  expect(await t.query(api.access.viewerPermissions, {})).toEqual([
    "keys:read",
  ]);
  expect(
    await t.query(api.access.viewerPermissions, { projectId: projectA }),
  ).toEqual(["keys:read", "keys:write"]);
  expect(
    await t.query(api.access.viewerPermissions, { projectId: projectB }),
  ).toEqual(["keys:read"]);

  // A policy row made for one stage counts only on that stage.
  const stageId = await t.run(
    async (ctx): Promise<Id<"stages">> =>
      await ctx.db.insert("stages", {
        authId: "auth_owner",
        projectId: projectA,
        name: "Production",
        kind: "production",
        isDefault: false,
        updatedAt: Date.now(),
      }),
  );
  const stagePolicy = await t.run(
    async (ctx): Promise<Id<"agentPolicies">> =>
      await ctx.db.insert("agentPolicies", {
        accountId: seeded.accountId,
        projectId: projectA,
        stageId: stageId,
        name: "stage only",
        document: {
          version: 1,
          mode: "enforce",
          rules: [{ id: "s", effect: "allow", actions: ["access:write"] }],
        },
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  );
  currentAuthId = "auth_owner";
  await t.mutation(api.access.updateRole, {
    roleId: roleId,
    policyIds: [policyId, stagePolicy],
  });
  currentAuthId = "auth_member";
  expect(await t.query(api.access.viewerPermissions, {})).toEqual([
    "keys:read",
  ]);
  // Holding members:write is not a way up: no admin tier, no role beyond one's own.
  currentAuthId = "auth_owner";
  await t.mutation(api.access.addRule, {
    policyId: policyId,
    permission: "members:write",
    scope: {},
  });
  const bossPolicy = await t.mutation(api.access.createPolicy, {
    name: "Boss",
    mode: "enforce",
  });
  await t.mutation(api.access.addRule, {
    policyId: bossPolicy,
    permission: "access:write",
    scope: {},
  });
  const bossRole = await t.mutation(api.access.createRole, {
    name: "Boss",
    policyIds: [bossPolicy],
  });
  currentAuthId = "auth_member";
  await expect(
    t.mutation(api.org.members.updateRole, {
      membershipId: seeded.memberId,
      role: "admin",
    }),
  ).rejects.toThrow(/Only an admin/);
  await expect(
    t.mutation(api.org.members.updateRole, {
      membershipId: seeded.memberId,
      role: "member",
      roleId: bossRole,
    }),
  ).rejects.toThrow(/which you do not hold/);
  // Nor is access:write: a rule or a role may not grant what the caller lacks.
  currentAuthId = "auth_owner";
  await t.mutation(api.access.addRule, {
    policyId: policyId,
    permission: "access:write",
    scope: {},
  });
  currentAuthId = "auth_member";
  await expect(
    t.mutation(api.access.addRule, {
      policyId: policyId,
      permission: "keys:write",
      scope: {},
    }),
  ).rejects.toThrow(/which you do not hold/);
  await expect(
    t.mutation(api.access.createRole, {
      name: "Boss too",
      policyIds: [bossPolicy],
    }),
  ).resolves.toBeDefined();

  currentAuthId = "auth_owner";
  const roles = await t.query(api.access.listRoles, {});
  const engineer = roles.find((role) => role.name === "Engineer");
  expect(engineer?.members).toEqual([{ name: "Ada", avatarUrl: undefined }]);
  expect(engineer?.permissions).toEqual([
    "keys:read",
    "members:write",
    "access:write",
  ]);
  await expect(
    t.mutation(api.access.removeRole, { roleId: roleId }),
  ).rejects.toThrow(/holds this role/);
});

test("access:write may not reach past its ceiling by switching a policy to enforce or dropping a deny", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const memberId = await t.run(async (ctx): Promise<Id<"orgMembers">> => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const ownerId = await ctx.db.insert("users", {
      authId: "auth_owner",
      email: "owner@example.com",
      name: "Owner",
      plan: "free",
      activeOrgId: orgId,
    });
    const memberUserId = await ctx.db.insert("users", {
      authId: "auth_member",
      email: "ada@example.com",
      name: "Ada",
      plan: "free",
      activeOrgId: orgId,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: ownerId,
      role: "owner",
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: memberUserId,
      role: "member",
      createdAt: now,
    });
  });

  currentAuthId = "auth_owner";
  const accessPolicy = await t.mutation(api.access.createPolicy, {
    name: "Access",
    mode: "enforce",
  });
  await t.mutation(api.access.addRule, {
    policyId: accessPolicy,
    permission: "access:write",
    scope: {},
  });
  const roleId = await t.mutation(api.access.createRole, {
    name: "Access admin",
    policyIds: [accessPolicy],
  });
  await t.mutation(api.org.members.updateRole, {
    membershipId: memberId,
    role: "member",
    roleId: roleId,
  });

  // An audit policy grants nothing, so its keys:write rule and the role
  // holding it pass; turning it on is where the ceiling must hold.
  currentAuthId = "auth_member";
  const audit = await t.mutation(api.access.createPolicy, {
    name: "Sleeper",
    mode: "audit",
  });
  await t.mutation(api.access.addRule, {
    policyId: audit,
    permission: "keys:write",
    scope: {},
  });
  await t.mutation(api.access.updateRole, {
    roleId: roleId,
    policyIds: [accessPolicy, audit],
  });
  await expect(
    t.mutation(api.access.updatePolicy, { policyId: audit, mode: "enforce" }),
  ).rejects.toThrow(/keys:write, which you do not hold/);
  expect(await t.query(api.access.viewerPermissions, {})).toEqual([
    "access:write",
  ]);

  // A deny masking an allow in the same policy passes; dropping it may not.
  const masked = await t.mutation(api.access.createPolicy, {
    name: "Masked",
    mode: "enforce",
  });
  const denyId = await t.mutation(api.access.addRule, {
    policyId: masked,
    permission: "keys:write",
    effect: "deny",
    scope: {},
  });
  await t.mutation(api.access.addRule, {
    policyId: masked,
    permission: "keys:write",
    scope: {},
  });
  await t.mutation(api.access.updateRole, {
    roleId: roleId,
    policyIds: [accessPolicy, masked],
  });
  await expect(
    t.mutation(api.access.removeRule, { policyId: masked, ruleId: denyId }),
  ).rejects.toThrow(/keys:write, which you do not hold/);
  expect(await t.query(api.access.viewerPermissions, {})).toEqual([
    "access:write",
  ]);

  // Narrowing stays open: a rename, dropping an allow, back to audit.
  await t.mutation(api.access.updatePolicy, {
    policyId: audit,
    name: "Renamed",
    mode: "audit",
  });
  const allowId = (await t.query(api.access.listPolicies, {}))
    .find((policy) => policy._id === masked)
    ?.rules.find((rule) => rule.effect === "allow")?.id;
  expect(allowId).toBeDefined();
  await t.mutation(api.access.removeRule, {
    policyId: masked,
    ruleId: allowId ?? "",
  });

  // The owner holds everything, so the same switch is theirs to make.
  currentAuthId = "auth_owner";
  await t.mutation(api.access.updatePolicy, {
    policyId: audit,
    mode: "enforce",
  });
  await t.mutation(api.access.removeRule, { policyId: masked, ruleId: denyId });

  // A deny that masks nothing comes off a policy that already grants more
  // than the caller holds: the edit answers only for what it adds.
  const wide = await t.mutation(api.access.createPolicy, {
    name: "Wide",
    mode: "enforce",
  });
  await t.mutation(api.access.addRule, {
    policyId: wide,
    permission: "keys:write",
    scope: {},
  });
  const unrelated = await t.mutation(api.access.addRule, {
    policyId: wide,
    permission: "members:write",
    effect: "deny",
    scope: {},
  });
  currentAuthId = "auth_member";
  await t.mutation(api.access.removeRule, {
    policyId: wide,
    ruleId: unrelated,
  });

  // A stage rule is weighed with its project, so keys:write held across the
  // project covers turning on a keys:write rule for one of its stages.
  const { projectId, stageId } = await t.run(
    async (
      ctx,
    ): Promise<{ projectId: Id<"projects">; stageId: Id<"stages"> }> => {
      const projectId = await ctx.db.insert("projects", {
        authId: "auth_owner",
        orgId: (await ctx.db.query("orgs").first())!._id,
        name: "a",
        slug: "a",
        updatedAt: Date.now(),
      });
      const stageId = await ctx.db.insert("stages", {
        authId: "auth_owner",
        projectId: projectId,
        name: "Production",
        kind: "production",
        isDefault: false,
        updatedAt: Date.now(),
      });

      return { projectId: projectId, stageId: stageId };
    },
  );
  currentAuthId = "auth_owner";
  await t.mutation(api.access.addRule, {
    policyId: accessPolicy,
    permission: "keys:write",
    scope: { projectId: projectId },
  });
  currentAuthId = "auth_member";
  const staged = await t.mutation(api.access.createPolicy, {
    name: "Stage keys",
    mode: "audit",
  });
  await t.mutation(api.access.addRule, {
    policyId: staged,
    permission: "keys:write",
    scope: { stageId: stageId },
  });
  await t.mutation(api.access.updatePolicy, {
    policyId: staged,
    mode: "enforce",
  });

  // A deny in one policy can mask another policy's allow in the same role, so
  // dropping it is weighed against every role that holds it.
  currentAuthId = "auth_owner";
  const granting = await t.mutation(api.access.createPolicy, {
    name: "Grants keys",
    mode: "enforce",
  });
  await t.mutation(api.access.addRule, {
    policyId: granting,
    permission: "keys:write",
    scope: {},
  });
  currentAuthId = "auth_member";
  const masking = await t.mutation(api.access.createPolicy, {
    name: "Masks keys",
    mode: "enforce",
  });
  const maskId = await t.mutation(api.access.addRule, {
    policyId: masking,
    permission: "keys:write",
    effect: "deny",
    scope: {},
  });
  await t.mutation(api.access.updateRole, {
    roleId: roleId,
    policyIds: [accessPolicy, granting, masking],
  });
  await expect(
    t.mutation(api.access.removeRule, { policyId: masking, ruleId: maskId }),
  ).rejects.toThrow(/keys:write, which you do not hold/);
  expect(await t.query(api.access.viewerPermissions, {})).toEqual([
    "access:write",
  ]);
});
