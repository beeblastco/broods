/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { clientErrorData, type ClientErrorData } from "../model/clientError";
import schema from "../schema";

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: "auth_member" }) },
}));

const modules = import.meta.glob("../**/*.ts");

const refusalTest = () => convexTest(schema, modules);

type T = ReturnType<typeof refusalTest>;

test("a member creating a project is told an admin is required", async () => {
  const t = refusalTest();
  await seed(t);

  const refusal = await refusalOf(
    t.mutation(api.project.create, { name: "second" }),
  );

  expect(refusal).toEqual({
    code: "forbidden",
    message: "Projects can only be created by an org admin.",
  });
});

test("a member creating a stage is told an admin is required", async () => {
  const t = refusalTest();
  const { projectId } = await seed(t);

  const refusal = await refusalOf(
    t.mutation(api.stage.create, { projectId: projectId, name: "Preview" }),
  );

  expect(refusal?.code).toBe("forbidden");
});

test("a member writing a workspace file is told an admin is required", async () => {
  const t = refusalTest();
  const { projectId } = await seed(t);

  const refusal = await refusalOf(
    t.mutation(api.workspace.files.create, {
      projectId: projectId,
      nodeId: "node-1",
      path: "notes",
      name: "notes",
      isFolder: true,
    }),
  );

  expect(refusal?.code).toBe("forbidden");
});

async function refusalOf(
  call: Promise<unknown>,
): Promise<ClientErrorData | null> {
  return await call.then(
    (): null => null,
    (error: unknown) => clientErrorData(error),
  );
}

async function seed(t: T): Promise<{ projectId: Id<"projects"> }> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
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
    const userId = await ctx.db.insert("users", {
      authId: "auth_member",
      email: "member@example.com",
      name: "member",
      plan: "free",
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "member",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });

    return { projectId: projectId };
  });
}
