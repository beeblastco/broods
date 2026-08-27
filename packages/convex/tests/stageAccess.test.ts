/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import type { OrgRole } from "../model/ownership/org";
import { getProjectForRole } from "../model/ownership/project";
import schema from "../schema";
import { listStagesForProject } from "../stage";

const modules = import.meta.glob("../**/*.ts");

const OWNER_AUTH_ID = "auth_owner";
const MEMBER_AUTH_ID = "auth_member";
const ADMIN_AUTH_ID = "auth_admin";
const STRANGER_AUTH_ID = "auth_stranger";

const accessTest = () => convexTest(schema, modules);

type T = ReturnType<typeof accessTest>;

// `stage.list` feeds every stage-keyed screen (canvas, dashboard, sandbox). An
// "admin" floor there left members with no stage id and a blank canvas.

async function seedOrgProject(t: T): Promise<Id<"projects">> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: OWNER_AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: OWNER_AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      authId: OWNER_AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      authId: OWNER_AUTH_ID,
      projectId: projectId,
      name: "Production",
      kind: "production" as const,
      isDefault: false,
      updatedAt: now,
    });

    const seedMember = async (authId: string, role: OrgRole) => {
      const userId = await ctx.db.insert("users", {
        authId: authId,
        email: authId + "@example.com",
        name: authId,
        plan: "free" as const,
      });
      await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: userId,
        role: role,
        createdAt: now,
      });
    };

    await seedMember(MEMBER_AUTH_ID, "member");
    await seedMember(ADMIN_AUTH_ID, "admin");

    return projectId;
  });
}

describe("stage listing by org role", () => {
  test("a member sees the project's stages, default first", async () => {
    const t = accessTest();
    const projectId = await seedOrgProject(t);

    const stages = await t.run(
      async (ctx) => await listStagesForProject(ctx, MEMBER_AUTH_ID, projectId),
    );

    expect(stages.map((stage) => stage.name)).toEqual([
      "Development",
      "Production",
    ]);
  });

  test("the project owner sees them without an org membership row", async () => {
    const t = accessTest();
    const projectId = await seedOrgProject(t);

    const stages = await t.run(
      async (ctx) => await listStagesForProject(ctx, OWNER_AUTH_ID, projectId),
    );

    expect(stages).toHaveLength(2);
  });

  test("a non-member of the org sees nothing", async () => {
    const t = accessTest();
    const projectId = await seedOrgProject(t);

    const stages = await t.run(
      async (ctx) =>
        await listStagesForProject(ctx, STRANGER_AUTH_ID, projectId),
    );

    expect(stages).toEqual([]);
  });

  test("a member is still barred from admin-gated paths like stage.remove", async () => {
    const t = accessTest();
    const projectId = await seedOrgProject(t);

    const [asMember, asAdmin] = await t.run(async (ctx) => [
      await getProjectForRole(ctx, MEMBER_AUTH_ID, projectId, "admin"),
      await getProjectForRole(ctx, ADMIN_AUTH_ID, projectId, "admin"),
    ]);

    expect(asMember).toBeNull();
    expect(asAdmin?._id).toBe(projectId);
  });
});
