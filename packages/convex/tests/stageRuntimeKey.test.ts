/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const AUTH_ID = "auth_owner";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  authKit: {
    getAuthUser: async () => ({ id: AUTH_ID, email: "owner@example.com" }),
  },
}));

const modules = import.meta.glob("../**/*.ts");

const stageKeyTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof stageKeyTest>;

describe("stage runtime key on create", () => {
  test("a new project's Development stage and a new stage get an active key", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = stageKeyTest();
    await seedOrg(t, { provisioned: true });

    const projectId = await t.mutation(api.project.create, { name: "Shop" });
    const stageId = await t.mutation(api.stage.create, {
      projectId: projectId,
      name: "staging",
    });

    const keyed = await activeKeyStages(t);
    expect(keyed).toHaveLength(2);
    expect(keyed).toContain(stageId);
  });

  test("a cloned stage gets no key, so its bot tokens stay unconnected", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = stageKeyTest();
    await seedOrg(t, { provisioned: true });

    const projectId = await t.mutation(api.project.create, { name: "Shop" });
    const [developmentId] = await activeKeyStages(t);
    const cloneId = await t.mutation(api.stage.create, {
      projectId: projectId,
      name: "staging",
      duplicateFromId: developmentId,
    });

    expect(await activeKeyStages(t)).not.toContain(cloneId);
  });

  test("creation still succeeds before the org has an API account", async () => {
    const t = stageKeyTest();
    await seedOrg(t, { provisioned: false });

    await t.mutation(api.project.create, { name: "Shop" });

    expect(await activeKeyStages(t)).toEqual([]);
  });
});

async function activeKeyStages(t: T): Promise<Id<"stages">[]> {
  return await t.run(async (ctx) =>
    (await ctx.db.query("agentDeployments").collect())
      .filter((row) => row.status === "active")
      .map((row) => row.stageId),
  );
}

async function seedOrg(
  t: T,
  { provisioned }: { provisioned: boolean },
): Promise<void> {
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
    if (provisioned) {
      await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "owner",
        secretHash: "hash-owner",
        status: "active",
        createdAt: 1,
        updatedAt: 1,
      });
    }
  });
}
