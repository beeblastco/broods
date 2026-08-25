/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ensureAutoLiveDeployment } from "./agentDeployments";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const autoLiveTest = () => convexTest(schema, modules);

type T = ReturnType<typeof autoLiveTest>;

const AUTH_ID = "auth_owner";
const ACTOR = {
  kind: "dashboardUser" as const,
  id: AUTH_ID,
  email: "owner@example.com",
};

async function seed(t: T, options: { withAccount: boolean }) {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: Date.now(),
    });
    const accountId = options.withAccount
      ? await ctx.db.insert("accounts", {
          orgId: orgId,
          username: "beeblast",
          secretHash: "hash-beeblast",
          status: "active" as const,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      : undefined;
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: Date.now(),
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Production",
      kind: "production" as const,
      isDefault: false,
      updatedAt: Date.now(),
    });

    return {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}

// Dashboard-created agents must be invocable without the manual
// "Generate API key" step, so `agentConfig.create` auto-ensures the stage's
// runtime deployment. The `returns` validators on the wire functions are
// runtime-only; this exercises the model helper directly for the same reason.
describe("ensureAutoLiveDeployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("mints an active deployment once and records the audit event", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = autoLiveTest();
    const seeded = await seed(t, { withAccount: true });

    const first = await t.run(async (ctx) => {
      await ensureAutoLiveDeployment(ctx, {
        authId: AUTH_ID,
        actor: ACTOR,
        projectId: seeded.projectId,
        stageId: seeded.stageId,
      });
      return await ctx.db
        .query("agentDeployments")
        .filter((q) => q.eq(q.field("stageId"), seeded.stageId))
        .collect();
    });
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("active");
    expect(first[0].apiKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first[0].projectSlug).toBe("demo-app");
    expect(first[0].stageSlug).toBe("production");

    // Second call is a no-op reuse, not a duplicate row.
    const second = await t.run(async (ctx) => {
      await ensureAutoLiveDeployment(ctx, {
        authId: AUTH_ID,
        actor: ACTOR,
        projectId: seeded.projectId,
        stageId: seeded.stageId,
      });
      return await ctx.db
        .query("agentDeployments")
        .filter((q) => q.eq(q.field("stageId"), seeded.stageId))
        .collect();
    });
    expect(second).toHaveLength(1);
    expect(second[0]._id).toBe(first[0]._id);
    expect(second[0].apiKeyHash).toBe(first[0].apiKeyHash);

    const audits = await t.run(async (ctx) =>
      ctx.db
        .query("configAuditEvents")
        .filter((q) => q.eq(q.field("projectId"), seeded.projectId))
        .collect(),
    );
    expect(audits.filter((event) => event.action === "ready")).toHaveLength(2);
  });

  test("no-ops when the org has no provisioned API account", async () => {
    vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
    const t = autoLiveTest();
    const seeded = await seed(t, { withAccount: false });

    const deployments = await t.run(async (ctx) => {
      await ensureAutoLiveDeployment(ctx, {
        authId: AUTH_ID,
        actor: ACTOR,
        projectId: seeded.projectId,
        stageId: seeded.stageId,
      });
      return await ctx.db.query("agentDeployments").collect();
    });
    expect(deployments).toHaveLength(0);
  });
});
