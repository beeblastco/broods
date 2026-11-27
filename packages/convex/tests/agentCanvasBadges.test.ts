/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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
  orgId: Id<"orgs">;
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
        voice: null,
        hasRun: false,
      },
      // Skills switched off load none, whatever the list still names.
      [configs.chat]: {
        publicAccess: false,
        skills: [],
        structuredOutput: false,
        voice: null,
        hasRun: false,
      },
      [configs.plain]: {
        publicAccess: false,
        skills: [],
        structuredOutput: false,
        voice: null,
        hasRun: false,
      },
    });
  });

  test("a skill list with a non-string entry still answers", async () => {
    const t = badgesTest();
    const { projectId, stageId } = await seed(t);
    caller.authId = OWNER_AUTH_ID;
    // The column checks shape only, so the Skills JSON editor can still save a number.
    const mixed = await t.run(
      async (ctx) =>
        await ctx.db.insert("agentConfigs", {
          authId: OWNER_AUTH_ID,
          name: "mixed",
          projectId: projectId,
          stageId: stageId,
          extraConfig: { skills: { enabled: true, allowed: ["triage", 1] } },
          updatedAt: Date.now(),
        }),
    );

    const badges = await t.query(api.agent.config.canvasBadges, {
      projectId: projectId,
      stageId: stageId,
    });

    expect(badges[mixed]).toEqual({
      publicAccess: false,
      skills: ["triage"],
      structuredOutput: false,
      voice: null,
      hasRun: false,
    });
  });

  test("hasRun turns true for the agent a run was filed under, not its neighbour", async () => {
    const t = badgesTest();
    const { configs, orgId, projectId, stageId } = await seed(t);
    caller.authId = OWNER_AUTH_ID;
    const accountId = await account(t, orgId);
    const writerAgentId = await linkAgent(t, accountId, configs.writer);
    await linkAgent(t, accountId, configs.chat);
    const read = async (): Promise<Record<string, boolean>> => {
      const badges = await t.query(api.agent.config.canvasBadges, {
        projectId: projectId,
        stageId: stageId,
      });

      return {
        chat: badges[configs.chat].hasRun,
        plain: badges[configs.plain].hasRun,
        writer: badges[configs.writer].hasRun,
      };
    };

    expect(await read()).toEqual({ chat: false, plain: false, writer: false });

    await fileRun(t, accountId, writerAgentId);

    expect(await read()).toEqual({ chat: false, plain: false, writer: true });
  });

  test("a run filed under another account leaves hasRun false", async () => {
    const t = badgesTest();
    const { configs, orgId, projectId, stageId } = await seed(t);
    caller.authId = OWNER_AUTH_ID;
    const writerAgentId = await linkAgent(
      t,
      await account(t, orgId),
      configs.writer,
    );

    await fileRun(t, await account(t, "org-elsewhere"), writerAgentId);

    const badges = await t.query(api.agent.config.canvasBadges, {
      projectId: projectId,
      stageId: stageId,
    });
    expect(badges[configs.writer].hasRun).toBe(false);
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

async function account(t: T, orgId: string): Promise<Id<"accounts">> {
  return await t.run(
    async (ctx) =>
      await ctx.db.insert("accounts", {
        orgId: orgId,
        username: `account-${Math.random()}`,
        secretHash: "hash",
        status: "active" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
  );
}

// The write core makes when a run ends, with the agent row's id as `agentId`.
async function fileRun(
  t: T,
  accountId: Id<"accounts">,
  agentId: Id<"agents">,
): Promise<void> {
  await t.mutation(internal.usage.recordTaskUsage, {
    accountId: accountId,
    endpointId: "",
    agentId: agentId,
    conversationKey: "conversation",
    taskId: `event#${Math.random()}`,
    modelProvider: "anthropic",
    modelId: "claude-test",
    finishedAt: Date.now(),
    durationMs: 1,
    status: "completed",
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 2,
    runtimeKind: "container",
    runtimeWallMs: 1,
    runtimeMemoryMb: 1,
    sandboxUsage: [],
    stepCount: 1,
    toolCallCount: 0,
  });
}

async function linkAgent(
  t: T,
  accountId: Id<"accounts">,
  configId: Id<"agentConfigs">,
): Promise<Id<"agents">> {
  return await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "agent",
      requireUserToken: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.patch(configId, { agentId: agentId });

    return agentId;
  });
}

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
      fields: Partial<
        Pick<Doc<"agentConfigs">, "extraConfig" | "outputFormat">
      > = {},
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
      orgId: orgId,
      otherStageConfigId: await config("preview-writer", otherStageId, {
        extraConfig: { publicAccess: true },
      }),
      otherStageId: otherStageId,
      projectId: projectId,
      stageId: stageId,
    };
  });
}
