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
  expect(policiesAllow([allow], "keys:read")).toBe(true);
  expect(policiesAllow([allow, deny], "keys:read")).toBe(false);
  expect(policiesAllow([allow], "keys:write")).toBe(false);
  expect(policiesAllow([{ ...allow, mode: "audit" }], "keys:read")).toBe(false);
  expect(dashboardPermissions({ tier: "member", policies: [allow] })).toEqual([
    "keys:read",
  ]);
  expect(dashboardPermissions({ tier: "admin", policies: [] })).toContain(
    "access:write",
  );
});

test("a member with a custom role sees the keys its policy allows", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const seeded = await t.run(
    async (ctx): Promise<{ orgId: Id<"orgs">; memberId: Id<"orgMembers"> }> => {
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
      await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "beeblast",
        secretHash: "hash-beeblast",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      return { orgId: orgId, memberId: memberId };
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

  currentAuthId = "auth_owner";
  const roles = await t.query(api.access.listRoles, {});
  const engineer = roles.find((role) => role.name === "Engineer");
  expect(engineer?.members).toEqual([{ name: "Ada", avatarUrl: undefined }]);
  expect(engineer?.permissions).toEqual(["keys:read"]);
  await expect(
    t.mutation(api.access.removeRole, { roleId: roleId }),
  ).rejects.toThrow(/holds this role/);
});
