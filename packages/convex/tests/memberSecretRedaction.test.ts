/// <reference types="vite/client" />
/**
 * Org members read agent configs and MCP servers but never a secret value in
 * them. Admins read and save the real values.
 */

import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { REDACTED_SECRET_VALUE } from "../model/configValues";
import type { OrgRole } from "../model/ownership/org";
import schema from "../schema";

const BOT_TOKEN = "xoxb-live-bot-token";
const WEBHOOK_SECRET = "whsec-live-signing";

const caller = vi.hoisted(() => ({ authId: "auth_admin" }));

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: caller.authId }) },
}));

const modules = import.meta.glob("../**/*.ts");

const redactionTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof redactionTest>;

interface Seeded {
  configId: Id<"agentConfigs">;
  projectId: Id<"projects">;
  stageId: Id<"stages">;
}

const EXTRA_CONFIG = {
  channels: {
    slack: { botToken: BOT_TOKEN, signingSecret: "${SLACK_SIGNING}" },
  },
  hooks: {
    webhooks: [{ url: "https://hooks.example.com", secret: WEBHOOK_SECRET }],
  },
};

describe("agent config reads", () => {
  test("a member gets channel tokens and webhook secrets masked", async () => {
    const t = redactionTest();
    const { configId } = await seed(t);
    caller.authId = "auth_member";

    const config = await t.query(api.agent.config.getById, {
      configId: configId,
    });

    expect(config?.extraConfig).toEqual({
      channels: {
        slack: {
          botToken: REDACTED_SECRET_VALUE,
          signingSecret: "${SLACK_SIGNING}",
        },
      },
      hooks: {
        webhooks: [
          { url: "https://hooks.example.com", secret: REDACTED_SECRET_VALUE },
        ],
      },
    });
  });

  test("an admin gets the stored values", async () => {
    const t = redactionTest();
    const { configId } = await seed(t);
    caller.authId = "auth_admin";

    const config = await t.query(api.agent.config.getById, {
      configId: configId,
    });

    expect(config?.extraConfig).toEqual(EXTRA_CONFIG);
  });

  test("a member cannot save the masked config over the stored secret", async () => {
    const t = redactionTest();
    const { configId } = await seed(t);
    caller.authId = "auth_member";
    const masked = await t.query(api.agent.config.getById, {
      configId: configId,
    });

    await expect(
      t.mutation(api.agent.config.update, {
        configId: configId,
        extraConfig: masked?.extraConfig,
      }),
    ).rejects.toThrow("org admin");
    expect(
      (await t.run(async (ctx) => ctx.db.get(configId)))?.extraConfig,
    ).toEqual(EXTRA_CONFIG);
  });
});

describe("MCP server reads", () => {
  test("a member sees header refs but not inline values", async () => {
    const t = redactionTest();
    const scope = await seed(t);
    caller.authId = "auth_member";

    const server = await t.query(api.mcp.getByNode, {
      projectId: scope.projectId,
      stageId: scope.stageId,
      nodeId: "node-1",
    });

    expect(server?.headers).toEqual({
      Authorization: "Bearer ${SEARCH_TOKEN}",
      "X-Tenant": REDACTED_SECRET_VALUE,
    });
  });

  test("an admin sees every header value", async () => {
    const t = redactionTest();
    const scope = await seed(t);
    caller.authId = "auth_admin";

    const server = await t.query(api.mcp.getByNode, {
      projectId: scope.projectId,
      stageId: scope.stageId,
      nodeId: "node-1",
    });

    expect(server?.headers).toEqual({
      Authorization: "Bearer ${SEARCH_TOKEN}",
      "X-Tenant": "tenant-42",
    });
  });
});

async function seed(t: T): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
    });
    const members: Array<[string, OrgRole]> = [
      ["auth_admin", "admin"],
      ["auth_member", "member"],
    ];
    for (const [authId, role] of members) {
      const userId = await ctx.db.insert("users", {
        authId: authId,
        email: `${authId}@example.com`,
        name: authId,
        plan: "free",
      });
      await ctx.db.insert("orgMembers", {
        orgId: orgId,
        userId: userId,
        role: role,
        createdAt: now,
      });
    }
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
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: "auth_owner",
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("agentConfigs", {
      authId: "auth_owner",
      name: "support",
      projectId: projectId,
      stageId: stageId,
      extraConfig: EXTRA_CONFIG,
      updatedAt: now,
    });
    await ctx.db.insert("mcp", {
      accountId: accountId,
      projectId: projectId,
      stageId: stageId,
      name: "search",
      transport: "http",
      url: "https://mcp.example.com",
      headers: {
        Authorization: "Bearer ${SEARCH_TOKEN}",
        "X-Tenant": "tenant-42",
      },
      nodeId: "node-1",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    return { configId: configId, projectId: projectId, stageId: stageId };
  });
}
