/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: "auth_owner" }) },
}));

const modules = import.meta.glob("../**/*.ts");

test("a dashboard policy belongs to the project's account, not the caller's active org", async () => {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      authId: "auth_owner",
      email: "owner@example.com",
      name: "owner",
      plan: "free",
    });
    const orgAccount = async (
      slug: string,
    ): Promise<{ orgId: Id<"orgs">; accountId: Id<"accounts"> }> => {
      const orgId = await ctx.db.insert("orgs", {
        name: slug,
        slug: slug,
        ownerAuthId: "auth_owner",
        plan: "free",
        createdAt: now,
      });
      await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: userId,
        role: "owner",
        createdAt: now,
      });
      const accountId = await ctx.db.insert("accounts", {
        orgId: orgId,
        username: slug,
        secretHash: `hash-${slug}`,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });

      return { orgId: orgId, accountId: accountId };
    };
    const home = await orgAccount("home");
    const other = await orgAccount("other");
    // The caller is looking at another org while editing home's project.
    await ctx.db.patch(userId, { activeOrgId: other.orgId });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: home.orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return {
      homeAccountId: home.accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });

  const policyId = await t.mutation(api.agent.policies.create, {
    projectId: seeded.projectId,
    stageId: seeded.stageId,
    name: "read-only",
    document: { version: 1, mode: "enforce", rules: [] },
  });

  const policy = await t.run(async (ctx) => ctx.db.get(policyId));
  expect(policy?.accountId).toBe(seeded.homeAccountId);
});
