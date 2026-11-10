/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const SECRET_HASH = "hash-project-resolve";

const resolveTest = () => convexTest(schema, modules);

type T = ReturnType<typeof resolveTest>;

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

test("`--project` names the same project on the GitHub and env routes", async () => {
  const t = resolveTest();
  const { orgId, projectId } = await seed(t);

  const github = await t.query(internal.github.cliProject, {
    orgId: orgId,
    slug: "my bot",
  });
  await t.mutation(internal.cli.sync.setEnvBySecretHash, {
    secretHash: SECRET_HASH,
    project: "my bot",
    stage: "development",
    name: "API_TOKEN",
    value: "x",
  });

  const env = await t.run(async (ctx) => ({
    projects: (await ctx.db.query("projects").collect()).length,
    envProject: (await ctx.db.query("environmentVariables").first())?.projectId,
  }));
  expect(github).toBe(projectId);
  expect(env).toEqual({ projects: 1, envProject: projectId });
});

async function seed(
  t: T,
): Promise<{ orgId: Id<"orgs">; projectId: Id<"projects"> }> {
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
      secretHash: SECRET_HASH,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "My Bot",
      slug: "my-bot",
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return { orgId: orgId, projectId: projectId };
  });
}
