/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";

const AUTH_ID = "auth_owner";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  authKit: {
    getAuthUser: async () => ({ id: AUTH_ID, email: "owner@example.com" }),
  },
}));

const modules = import.meta.glob("../**/*.ts");

test("a rename keeps the description; an empty description clears it", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "owner@example.com",
      name: "Owner",
      plan: "free",
    });
    const orgId = await ctx.db.insert("orgs", {
      name: "owner",
      slug: "owner",
      ownerAuthId: AUTH_ID,
      plan: "free",
      createdAt: 1,
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner",
      createdAt: 1,
    });
    await ctx.db.patch(userId, { activeOrgId: orgId });
  });
  const projectId = await t.mutation(api.project.create, { name: "Shop" });
  const description = async (): Promise<string | undefined> =>
    (await t.run((ctx) => ctx.db.get(projectId)))?.description;

  await t.mutation(api.project.update, {
    projectId: projectId,
    name: "Shop",
    description: "Storefront agents",
  });
  await t.mutation(api.project.update, { projectId: projectId, name: "Store" });
  expect(await description()).toBe("Storefront agents");

  await t.mutation(api.project.update, {
    projectId: projectId,
    name: "Store",
    description: "",
  });
  expect(await description()).toBeUndefined();
});
