/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const OWNER_AUTH_ID = "auth_owner";

const caller = vi.hoisted(() => ({ authId: "auth_owner" }));

// The query reads its caller through the WorkOS component, absent from the test runtime.
vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: caller.authId }) },
}));

const modules = import.meta.glob("../**/*.ts");

const badgesTest = (): TestConvex<typeof schema> => convexTest(schema, modules);

type T = ReturnType<typeof badgesTest>;

type Seeded = {
  configs: Record<"chat" | "plain" | "writer", Id<"agentConfigs">>;
  otherStageConfigId: Id<"agentConfigs">;
  otherStageId: Id<"stages">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
};

describe("agent.config.canvasBadges", () => {
  test("reads each agent of the stage as its card draws it", async () => {
    const t = badgesTest();
    const { configs, projectId, stageId } = await seed(t);
    caller.authId = OWNER_AUTH_ID;

    const badges = await t.query(api.agent.config.canvasBadges, {
      projectId: projectId,
      stageId: stageId,
    });

    expect(badges).toEqual({
      [configs.writer]: {
        publicAccess: true,
        skills: ["skills/release-notes", "triage"],
        structuredOutput: true,
      },
      // Skills switched off load none, whatever the list still names.
      [configs.chat]: {
        publicAccess: false,
        skills: [],
        structuredOutput: false,
      },
      [configs.plain]: {
        publicAccess: false,
        skills: [],
        structuredOutput: false,
      },
    });
  });

  test("a row its writers left malformed still answers", async () => {
    const t = badgesTest();
    const { projectId, stageId } = await seed(t);
    caller.authId = OWNER_AUTH_ID;
    const malformed = await t.run(
      async (ctx) =>
        await ctx.db.insert("agentConfigs", {
          authId: OWNER_AUTH_ID,
          name: "malformed",
          projectId: projectId,
          stageId: stageId,
          // `output: null` from a CLI manifest, a list with a non-string entry
          // from the Skills JSON editor.
          outputFormat: null,
          extraConfig: { skills: { enabled: true, allowed: ["triage", 1] } },
          updatedAt: Date.now(),
        }),
    );

    const badges = await t.query(api.agent.config.canvasBadges, {
      projectId: projectId,
      stageId: stageId,
    });

    expect(badges[malformed]).toEqual({
      publicAccess: false,
      skills: ["triage"],
      structuredOutput: false,
    });
  });

  test("with no stage reads the project's default stage", async () => {
    const t = badgesTest();
    const { configs, otherStageConfigId, projectId } = await seed(t);
    caller.authId = OWNER_AUTH_ID;

    const badges = await t.query(api.agent.config.canvasBadges, {
      projectId: projectId,
    });

    expect(Object.keys(badges).sort()).toEqual(
      [configs.chat, configs.plain, configs.writer].sort(),
    );
    expect(badges[otherStageConfigId]).toBeUndefined();
  });

  test("a member reads the badges, as they read the config", async () => {
    const t = badgesTest();
    const { configs, projectId, stageId } = await seed(t);
    caller.authId = "auth_member";

    const badges = await t.query(api.agent.config.canvasBadges, {
      projectId: projectId,
      stageId: stageId,
    });

    expect(badges[configs.writer]?.publicAccess).toBe(true);
  });

  test("answers nothing outside the org or for another project's stage", async () => {
    const t = badgesTest();
    const { otherStageId, projectId, stageId } = await seed(t);
    const other = await seed(t);

    caller.authId = "auth_stranger";
    expect(
      await t.query(api.agent.config.canvasBadges, {
        projectId: projectId,
        stageId: stageId,
      }),
    ).toEqual({});

    caller.authId = OWNER_AUTH_ID;
    expect(
      await t.query(api.agent.config.canvasBadges, {
        projectId: other.projectId,
        stageId: otherStageId,
      }),
    ).toEqual({});
  });
});

async function seed(t: T): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "example",
      slug: `example-${now}-${Math.random()}`,
      ownerAuthId: OWNER_AUTH_ID,
      plan: "free" as const,
      createdAt: now,
    });
    const memberId = await ctx.db.insert("users", {
      authId: "auth_member",
      email: `member-${Math.random()}@example.com`,
      name: "member",
      plan: "free",
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: memberId,
      role: "member",
      createdAt: now,
    });
    const projectId = await ctx.db.insert("projects", {
      authId: OWNER_AUTH_ID,
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stage = async (
      name: string,
      isDefault: boolean,
    ): Promise<Id<"stages">> =>
      await ctx.db.insert("stages", {
        authId: OWNER_AUTH_ID,
        projectId: projectId,
        name: name,
        kind: "development" as const,
        isDefault: isDefault,
        updatedAt: now,
      });
    const stageId = await stage("development", true);
    const otherStageId = await stage("preview", false);
    const config = async (
      name: string,
      stage: Id<"stages">,
      fields: { extraConfig?: unknown; outputFormat?: unknown } = {},
    ): Promise<Id<"agentConfigs">> =>
      await ctx.db.insert("agentConfigs", {
        authId: OWNER_AUTH_ID,
        name: name,
        projectId: projectId,
        stageId: stage,
        systemPrompt: "A prompt the cards never draw.",
        ...fields,
        updatedAt: now,
      });

    return {
      configs: {
        chat: await config("chat", stageId, {
          extraConfig: { skills: { enabled: false, allowed: ["triage"] } },
          outputFormat: { type: "text" },
        }),
        plain: await config("plain", stageId),
        writer: await config("writer", stageId, {
          extraConfig: {
            publicAccess: true,
            skills: {
              enabled: true,
              allowed: ["skills/release-notes", "triage"],
            },
          },
          outputFormat: { type: "object", schema: { type: "object" } },
        }),
      },
      otherStageConfigId: await config("preview-writer", otherStageId, {
        extraConfig: { publicAccess: true },
      }),
      otherStageId: otherStageId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}
