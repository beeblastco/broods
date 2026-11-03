/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { assertStoredAgentConfig } from "../model/agentConfigColumns";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

type Columns = Partial<
  Pick<Doc<"agentConfigs">, "extraConfig" | "outputFormat">
>;

// The key paths of the production and dev rows on 2026-11-03, placeholders unresolved.
const PRODUCTION_ROW: Columns = {
  extraConfig: {
    mcp: {
      k57mcpserver00000000000000000000: {
        enabled: true,
        headers: { Authorization: "Bearer ${MCP_TOKEN}" },
      },
    },
    model: { maxOutputTokens: 8192, reasoning: "high" },
    provider: {
      custom: {
        apiKey: "${AI_API_KEY}",
        baseURL: "${AI_BASE_URL}",
        name: "ovh",
      },
    },
    publicAccess: true,
  },
};

const DEV_ROW: Columns = {
  extraConfig: {
    channels: {
      discord: { id: "discord", botToken: "${DISCORD_BOT_TOKEN}" },
      github: { id: "github", appId: "${GITHUB_APP_ID}" },
      slack: { id: "slack", botToken: "${SLACK_BOT_TOKEN}" },
      telegram: { id: "telegram", botToken: "${TELEGRAM_BOT_TOKEN}" },
      zalo: { id: "zalo", botToken: "${ZALO_BOT_TOKEN}" },
    },
    hooks: {
      code: [{ hookId: "k57hook0000000000000000000000000", enabled: true }],
    },
    model: { reasoning: "medium" },
    provider: { anthropic: { apiKey: "${ANTHROPIC_API_KEY}" } },
    sandboxes: ["sb_default"],
    scheduler: { enabled: true },
    subagent: { enabled: true },
    workspaces: [{ name: "docs", workspaceId: "ws_docs" }],
  },
};

describe("agentConfigs extraConfig and outputFormat columns", () => {
  test("store every row shape that exists, placeholders included", async () => {
    for (const row of [
      PRODUCTION_ROW,
      DEV_ROW,
      {},
      { outputFormat: { type: "object", schema: { type: "object" } } },
    ]) {
      await expect(insertAgentConfig(row)).resolves.toBeDefined();
    }
  });

  // A branch may carry keys the rules do not list; the top level holds only known branches.
  test("refuse an unknown top-level key", async () => {
    await expect(
      // @ts-expect-error -- the column does not list `sandbox`, a removed branch
      insertAgentConfig({ extraConfig: { sandbox: "sb_default" } }),
    ).rejects.toThrow(/sandbox/);
  });

  test("a sync refuses the wrong shape with the field path", () => {
    expect(() =>
      assertStoredAgentConfig({ extraConfig: { sandboxes: ["sb_default"] } }),
    ).not.toThrow();
    expect(() =>
      // @ts-expect-error -- a manifest can hold a string where the column wants a list
      assertStoredAgentConfig({ extraConfig: { sandboxes: "sb_default" } }),
    ).toThrow("config.sandboxes must be array, got string");
  });
});

async function insertAgentConfig(columns: Columns): Promise<string> {
  const t = convexTest(schema, modules);

  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "demo",
      slug: "demo",
      ownerAuthId: "auth_owner",
      plan: "free",
      createdAt: now,
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
      name: "development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return await ctx.db.insert("agentConfigs", {
      authId: "auth_owner",
      name: "agent",
      projectId: projectId,
      stageId: stageId,
      ...columns,
      updatedAt: now,
    });
  });
}
