/// <reference types="vite/client" />
/** A project key is minted with its `bpdk_` prefix and resolves to its stage by hash. */

import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

type Seeded = {
  accountId: Id<"accounts">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

vi.mock(
  "../auth",
  (): { authKit: { getAuthUser: () => Promise<{ id: string }> } } => ({
    authKit: {
      getAuthUser: async (): Promise<{ id: string }> => ({ id: "auth_owner" }),
    },
  }),
);

test("a project key is minted as bpdk_ and resolves scoped to its stage", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const seeded = await t.run(async (ctx): Promise<Seeded> => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Production",
      kind: "production",
      isDefault: false,
      updatedAt: now,
    });

    return { accountId: accountId, projectId: projectId, stageId: stageId };
  });

  const created = await t.mutation(api.deployKeys.create, {
    projectId: seeded.projectId,
    stageId: seeded.stageId,
    name: "CI",
  });

  expect(created.token).toMatch(/^bpdk_[A-Za-z0-9_-]{43}$/);
  expect(created.keyHint).toBe(`bpdk_…${created.token.slice(-4)}`);
  expect(
    await t.query(internal.cli.sync.resolveCliAuth, {
      tokenHash: await sha256Hex(created.token),
      keyKind: "project",
      project: "demo-app",
      stage: "production",
    }),
  ).toMatchObject({
    accountId: seeded.accountId,
    scoped: true,
    deployKeyId: created._id,
  });
});
