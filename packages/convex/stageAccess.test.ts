/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import { getOwnedProject, getProjectForRole } from "./model/ownership/project";
import type { OrgRole } from "./model/ownership/org";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const accessTest = () => convexTest(schema, modules);

type T = ReturnType<typeof accessTest>;

const OWNER_AUTH_ID = "auth_owner";
const MEMBER_AUTH_ID = "auth_member";
const ADMIN_AUTH_ID = "auth_admin";

// `stage.list` feeds the whole stage-scoped UI (canvas, dashboard, sandbox).
// Reading it behind an "admin" floor left plain members with no stage id, so
// every stage-keyed query skipped and the canvas rendered empty.

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

describe("project visibility by org role", () => {
  test("a member can read the project stage.list resolves through", async () => {
    const t = accessTest();
    const projectId = await seedOrgProject(t);

    const project = await t.run(
      async (ctx) => await getOwnedProject(ctx, MEMBER_AUTH_ID, projectId),
    );

    expect(project?._id).toBe(projectId);
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

  test("a non-member of the org sees nothing", async () => {
    const t = accessTest();
    const projectId = await seedOrgProject(t);

    const project = await t.run(
      async (ctx) => await getOwnedProject(ctx, "auth_stranger", projectId),
    );

    expect(project).toBeNull();
  });
});
