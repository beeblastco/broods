/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function envTest() {
  return convexTest(schema, modules);
}

async function seedProjectStage(t: ReturnType<typeof envTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "BeeBlast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free" as const,
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });

    return { projectId: projectId, stageId: stageId };
  });
}

describe("environmentVariables.set", () => {
  test("records hasValue on insert and update", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = envTest();
    const { projectId, stageId } = await seedProjectStage(t);

    await t.mutation(internal.environmentVariables.setForTest, {
      projectId: projectId,
      stageId: stageId,
      name: "VERTEX_API_KEY",
      value: "",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("environmentVariables")
        .withIndex("by_stageId_and_name", (q) =>
          q.eq("stageId", stageId).eq("name", "VERTEX_API_KEY"),
        )
        .unique();

      expect(row?.hasValue).toBe(false);
    });

    await t.mutation(internal.environmentVariables.setForTest, {
      projectId: projectId,
      stageId: stageId,
      name: "OPENAI_API_KEY",
      value: "live-key",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("environmentVariables")
        .withIndex("by_stageId_and_name", (q) =>
          q.eq("stageId", stageId).eq("name", "OPENAI_API_KEY"),
        )
        .unique();

      expect(row?.hasValue).toBe(true);
    });

    await t.mutation(internal.environmentVariables.setForTest, {
      projectId: projectId,
      stageId: stageId,
      name: "VERTEX_API_KEY",
      value: "live-key",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("environmentVariables")
        .withIndex("by_stageId_and_name", (q) =>
          q.eq("stageId", stageId).eq("name", "VERTEX_API_KEY"),
        )
        .unique();

      expect(row?.hasValue).toBe(true);
    });

    await t.mutation(internal.environmentVariables.setForTest, {
      projectId: projectId,
      stageId: stageId,
      name: "VERTEX_API_KEY",
      value: "",
    });

    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("environmentVariables")
        .withIndex("by_stageId_and_name", (q) =>
          q.eq("stageId", stageId).eq("name", "VERTEX_API_KEY"),
        )
        .unique();

      expect(row?.hasValue).toBe(false);
    });
  });
});
