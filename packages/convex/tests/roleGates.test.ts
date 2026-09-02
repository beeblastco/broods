/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  assertNotForeign,
  handleEnvRoute,
  stageCronByName,
} from "../cli/httpRoutes";
import type { OrgRole } from "../model/ownership/org";
import { getProjectForRole } from "../model/ownership/project";
import { getOwnedStage } from "../model/ownership/stage";
import { readCapped } from "../model/skills";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const OWNER_AUTH_ID = "auth_owner";
const ADMIN_AUTH_ID = "auth_admin";
const MEMBER_AUTH_ID = "auth_member";
// Created the project, then left the org: no membership row.
const CREATOR_AUTH_ID = "auth_creator";

const roleTest = () => convexTest(schema, modules);

type T = ReturnType<typeof roleTest>;

async function seed(t: T): Promise<{
  accountId: Id<"accounts">;
  orgId: Id<"orgs">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
  otherStageId: Id<"stages">;
}> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: OWNER_AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash-beeblast",
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: CREATOR_AUTH_ID,
      orgId: orgId,
      name: "demo-app",
      slug: "demo-app",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: CREATOR_AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });
    const otherStageId = await ctx.db.insert("stages", {
      authId: CREATOR_AUTH_ID,
      projectId: projectId,
      name: "Production",
      kind: "production" as const,
      isDefault: false,
      updatedAt: now,
    });
    const seedMember = async (authId: string, role: OrgRole) => {
      const userId = await ctx.db.insert("users", {
        authId: authId,
        email: `${authId}@example.com`,
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
    await seedMember(ADMIN_AUTH_ID, "admin");
    await seedMember(MEMBER_AUTH_ID, "member");
    await ctx.db.insert("users", {
      authId: CREATOR_AUTH_ID,
      email: "creator@example.com",
      name: "creator",
      plan: "free" as const,
    });

    return {
      accountId: accountId,
      orgId: orgId,
      projectId: projectId,
      stageId: stageId,
      otherStageId: otherStageId,
    };
  });
}

describe("project and stage ownership by org role", () => {
  test("the org owner is an owner without a membership row", async () => {
    const t = roleTest();
    const { projectId, stageId } = await seed(t);

    await t.run(async (ctx) => {
      expect(
        await getProjectForRole(ctx, OWNER_AUTH_ID, projectId, "owner"),
      ).not.toBeNull();
      expect(
        await getOwnedStage(ctx, OWNER_AUTH_ID, stageId, "admin"),
      ).not.toBeNull();
    });
  });

  test("a project creator who left the org sees nothing", async () => {
    const t = roleTest();
    const { projectId, stageId } = await seed(t);

    await t.run(async (ctx) => {
      expect(await getProjectForRole(ctx, CREATOR_AUTH_ID, projectId)).toBe(
        null,
      );
      expect(await getOwnedStage(ctx, CREATOR_AUTH_ID, stageId)).toBeNull();
    });
  });

  test("a member reads but does not meet the admin floor", async () => {
    const t = roleTest();
    const { projectId, stageId } = await seed(t);

    await t.run(async (ctx) => {
      expect(
        await getProjectForRole(ctx, MEMBER_AUTH_ID, projectId),
      ).not.toBeNull();
      expect(
        await getProjectForRole(ctx, MEMBER_AUTH_ID, projectId, "admin"),
      ).toBeNull();
      expect(await getOwnedStage(ctx, MEMBER_AUTH_ID, stageId)).not.toBeNull();
      expect(
        await getOwnedStage(ctx, MEMBER_AUTH_ID, stageId, "admin"),
      ).toBeNull();
      expect(
        await getOwnedStage(ctx, ADMIN_AUTH_ID, stageId, "admin"),
      ).not.toBeNull();
    });
  });
});

describe("CLI tokens follow the current org membership", () => {
  async function seedToken(
    t: T,
    accountId: Id<"accounts">,
    orgId: Id<"orgs">,
  ): Promise<string> {
    const tokenHash = "hash-cli-token";
    await t.run(async (ctx) => {
      await ctx.db.insert("cliTokens", {
        tokenHash: tokenHash,
        authId: ADMIN_AUTH_ID,
        orgId: orgId,
        accountId: accountId,
        status: "active" as const,
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
      });
    });

    return tokenHash;
  }

  async function setAdminRole(t: T, role: OrgRole | null): Promise<void> {
    await t.run(async (ctx) => {
      const user = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", ADMIN_AUTH_ID))
        .unique();
      const membership = await ctx.db
        .query("orgMembers")
        .withIndex("by_userId", (q) => q.eq("userId", user!._id))
        .unique();
      if (role === null) await ctx.db.delete(membership!._id);
      else await ctx.db.patch(membership!._id, { role: role });
    });
  }

  test("resolves while the user is still an admin", async () => {
    const t = roleTest();
    const { accountId, orgId } = await seed(t);
    const tokenHash = await seedToken(t, accountId, orgId);

    expect(
      await t.mutation(internal.cli.auth.resolveCliToken, {
        tokenHash: tokenHash,
      }),
    ).toMatchObject({ accountId: accountId, authId: ADMIN_AUTH_ID });
  });

  test("stops resolving once the user is demoted or removed", async () => {
    const t = roleTest();
    const { accountId, orgId } = await seed(t);
    const tokenHash = await seedToken(t, accountId, orgId);

    await setAdminRole(t, "member");
    expect(
      await t.mutation(internal.cli.auth.resolveCliToken, {
        tokenHash: tokenHash,
      }),
    ).toBeNull();

    await setAdminRole(t, null);
    expect(
      await t.mutation(internal.cli.auth.resolveCliToken, {
        tokenHash: tokenHash,
      }),
    ).toBeNull();
  });
});

describe("stage-scoped sync of account-wide resources", () => {
  test("lists which stage manages each external resource", async () => {
    const t = roleTest();
    const { accountId, projectId, stageId, otherStageId } = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("cliExternalResources", {
        accountId: accountId,
        projectId: projectId,
        stageId: otherStageId,
        kind: "skill" as const,
        name: "release-notes",
        externalId: `${accountId}/release-notes`,
        config: {},
        updatedAt: Date.now(),
      });
    });

    const rows = await t.query(
      internal.cli.sync.listExternalResourcesForAccount,
      { accountId: accountId },
    );
    const foreign = new Set(
      rows
        .filter((row) => row.stageId !== stageId)
        .map((row) => `${row.kind}:${row.name}`),
    );

    expect(rows).toEqual([
      { kind: "skill", name: "release-notes", stageId: otherStageId },
    ]);
    expect(() => assertNotForeign(foreign, "skill", "release-notes")).toThrow(
      /managed by another stage/,
    );
    expect(() =>
      assertNotForeign(foreign, "hook", "release-notes"),
    ).not.toThrow();
  });

  test("a cron name is only reused for this stage's own agents", () => {
    const existing = [
      { name: "nightly", agentId: "agent_prod" },
      { name: "hourly", agentId: "agent_dev" },
    ];
    const stageAgentIds = new Set(["agent_dev"]);

    expect(stageCronByName(existing, stageAgentIds, "hourly")).toEqual(
      existing[1],
    );
    expect(stageCronByName(existing, stageAgentIds, "fresh")).toBeNull();
    expect(() => stageCronByName(existing, stageAgentIds, "nightly")).toThrow(
      /already used by another stage/,
    );
  });
});

describe("readCapped", () => {
  function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start: function (controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  test("returns the bytes when under the cap", async () => {
    const bytes = await readCapped(
      streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]),
      3,
    );

    expect([...bytes]).toEqual([1, 2, 3]);
  });

  test("refuses a stream that grows past the cap", async () => {
    await expect(
      readCapped(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), 2),
    ).rejects.toThrow(/exceeds the 2 byte limit/);
  });
});

describe("deploy keys and environment values", () => {
  test("a deploy key is refused before any value is read", async () => {
    const t = roleTest();
    const { accountId } = await seed(t);
    const response = await handleEnvRoute(
      // The refusal happens before the context is touched.
      {} as never,
      new Request("https://config.example/env/API_KEY", { method: "GET" }),
      {
        kind: "env",
        project: "demo-app",
        stage: "development",
        name: "API_KEY",
      },
      {
        accountId: accountId,
        secretHash: "hash-beeblast",
        scoped: true,
        deployKeyId: "deploy-key" as never,
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/Deploy keys cannot read/),
    });
  });
});
