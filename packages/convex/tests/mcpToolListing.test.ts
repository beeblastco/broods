/// <reference types="vite/client" />

import cronsComponent from "@convex-dev/crons/test";
import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import schema from "../schema";

const AUTH_ID = "user_mcp_tool_listing";
const modules = import.meta.glob("../**/*.ts");
const INPUT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { path: { type: "string" } },
};

afterEach((): void => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("a tool whose schema has `$` keys lists as JSON text", async (): Promise<void> => {
  vi.stubEnv("BROODS_ACCOUNT_MANAGE_URL", "https://core.example.invalid");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> =>
      Response.json({
        tools: [{ name: "read_docs", inputSchema: INPUT_SCHEMA }],
      }),
    ),
  );
  const t = convexTest(schema, modules);
  workosTest.register(t);
  cronsComponent.register(t);
  const now = new Date().toISOString();
  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    event: {
      id: "evt_mcp_tool_listing",
      event: "user.created",
      createdAt: now,
      data: {
        id: AUTH_ID,
        email: "mcp-tools@example.invalid",
        emailVerified: true,
        metadata: {},
        createdAt: now,
        updatedAt: now,
      },
    },
  });
  await t.run(async (ctx): Promise<void> => {
    await ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "mcp-tools@example.invalid",
      name: "Tools owner",
      plan: "free",
    });
  });
  const caller = t.withIdentity({ subject: AUTH_ID });
  const orgId = await caller.mutation(api.org.orgs.create, { name: "Tools" });
  await t.mutation(internal.account.accounts.create, {
    orgId: orgId,
    username: "mcp-tools",
    secretHash: "hash-mcp-tools",
  });
  const { projectId, stageId } = await t.run(async (ctx) => {
    const projectId = await ctx.db.insert("projects", {
      authId: AUTH_ID,
      orgId: orgId,
      name: "tools",
      slug: "tools",
      updatedAt: Date.now(),
    });
    const stageId = await ctx.db.insert("stages", {
      authId: AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: Date.now(),
    });

    return { projectId: projectId, stageId: stageId };
  });

  const saved = await caller.action(api.mcp.saveForNode, {
    projectId: projectId,
    stageId: stageId,
    nodeId: "mcp-node",
    nodeLabel: "dock",
    url: "https://mcp.example.com/mcp",
  });

  expect(saved.tools).toEqual([
    { name: "read_docs", inputSchema: JSON.stringify(INPUT_SCHEMA) },
  ]);
});
