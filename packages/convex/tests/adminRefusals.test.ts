/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { clientErrorData, type ClientErrorData } from "../model/clientError";
import schema from "../schema";

const caller = vi.hoisted(() => ({ authId: "auth_member" }));

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: caller.authId }) },
}));

const modules = import.meta.glob("../**/*.ts");

const refusalTest = () => convexTest(schema, modules);

type T = ReturnType<typeof refusalTest>;

interface ProjectIds {
  configId: Id<"agentConfigs">;
  fileId: Id<"workspaceFiles">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}

type ByIdWrite = (t: T, ids: ProjectIds) => Promise<unknown>;

const BY_ID_WRITES: Record<string, ByIdWrite> = {
  "agent config remove": (t, ids) =>
    t.mutation(api.agent.config.remove, { configId: ids.configId }),
  "project remove": (t, ids) =>
    t.mutation(api.project.remove, { projectId: ids.projectId }),
  "project update": (t, ids) =>
    t.mutation(api.project.update, {
      projectId: ids.projectId,
      name: "renamed",
    }),
  "stage remove": (t, ids) =>
    t.mutation(api.stage.remove, { stageId: ids.stageId }),
  "workspace file remove": (t, ids) =>
    t.mutation(api.workspace.files.remove, { fileId: ids.fileId }),
  "workspace file rename": (t, ids) =>
    t.mutation(api.workspace.files.rename, {
      fileId: ids.fileId,
      newName: "renamed",
    }),
};

test("a member creating a project is told an admin is required", async () => {
  const t = refusalTest();
  await seed(t);
  caller.authId = "auth_member";

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
  caller.authId = "auth_member";

  const refusal = await refusalOf(
    t.mutation(api.stage.create, { projectId: projectId, name: "Preview" }),
  );

  expect(refusal?.code).toBe("forbidden");
});

test("a member writing a workspace file is told an admin is required", async () => {
  const t = refusalTest();
  const { projectId } = await seed(t);
  caller.authId = "auth_member";

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

test.each(Object.keys(BY_ID_WRITES))(
  "%s: a member is told an admin is required",
  async (name) => {
    const t = refusalTest();
    const ids = await seed(t);
    caller.authId = "auth_member";

    const refusal = await refusalOf(BY_ID_WRITES[name](t, ids));

    expect(refusal?.code).toBe("forbidden");
  },
);

test.each(Object.keys(BY_ID_WRITES))(
  "%s: a stranger gets the same answer for a real and a deleted id",
  async (name) => {
    const t = refusalTest();
    const real = await seed(t);
    const gone = await seedProject(t, real.orgId);
    await t.run(async (ctx) => {
      await ctx.db.delete(gone.configId);
      await ctx.db.delete(gone.fileId);
      await ctx.db.delete(gone.stageId);
      await ctx.db.delete(gone.projectId);
    });
    caller.authId = "auth_stranger";

    const forReal = await refusalOf(BY_ID_WRITES[name](t, real));
    const forGone = await refusalOf(BY_ID_WRITES[name](t, gone));

    expect(forReal?.code).toBe("not_found");
    expect(forReal).toEqual(forGone);
  },
);

async function refusalOf(
  call: Promise<unknown>,
): Promise<ClientErrorData | null> {
  return await call.then(
    (): null => null,
    (error: unknown) => clientErrorData(error),
  );
}

async function seed(t: T): Promise<ProjectIds & { orgId: Id<"orgs"> }> {
  const orgId = await t.run(async (ctx) => {
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
    const strangerOrgId = await ctx.db.insert("orgs", {
      name: "elsewhere",
      slug: "elsewhere",
      ownerAuthId: "auth_stranger",
      plan: "free",
      createdAt: now,
    });
    await ctx.db.insert("accounts", {
      orgId: strangerOrgId,
      username: "elsewhere",
      secretHash: "hash-elsewhere",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("users", {
      authId: "auth_stranger",
      email: "stranger@example.com",
      name: "stranger",
      plan: "free",
    });

    return orgId;
  });

  return { ...(await seedProject(t, orgId)), orgId: orgId };
}

async function seedProject(t: T, orgId: Id<"orgs">): Promise<ProjectIds> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo-app",
      slug: `demo-app-${now}`,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Preview",
      kind: "custom",
      isDefault: false,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("agentConfigs", {
      authId: "auth_owner",
      name: "helper",
      projectId: projectId,
      stageId: stageId,
      updatedAt: now,
    });
    const fileId = await ctx.db.insert("workspaceFiles", {
      authId: "auth_owner",
      projectId: projectId,
      nodeId: "node-1",
      path: "notes.md",
      name: "notes.md",
      isFolder: false,
      createdAt: now,
      updatedAt: now,
    });

    return {
      configId: configId,
      fileId: fileId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}
