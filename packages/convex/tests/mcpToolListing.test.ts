/// <reference types="vite/client" />

import cronsComponent from "@convex-dev/crons/test";
import workosTest from "@convex-dev/workos-authkit/test";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { apiErrorBody } from "../model/apiError";
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

test("tools and results with `$` keys travel as JSON text", async (): Promise<void> => {
  vi.stubEnv("BROODS_ACCOUNT_MANAGE_URL", "https://core.example.invalid");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> =>
      Response.json({
        tools: [{ name: "read_docs", inputSchema: INPUT_SCHEMA }],
        result: { structuredContent: INPUT_SCHEMA },
        durationMs: 5,
      }),
    ),
  );
  const { caller, node } = await ownedMcpNode();
  const listed = [
    {
      name: "read_docs",
      inputSchemaJson: JSON.stringify(INPUT_SCHEMA, null, 2),
    },
  ];

  const saved = await caller.action(api.mcp.saveForNode, {
    ...node,
    nodeLabel: "dock",
    url: "https://mcp.example.com/mcp",
  });
  expect(saved.tools).toEqual(listed);
  expect(await caller.action(api.mcp.listTools, node)).toEqual(listed);
  expect(
    await caller.action(api.mcp.callTool, {
      ...node,
      toolName: "read_docs",
      inputJson: '{"$ref": "#/path"}',
    }),
  ).toEqual({
    isError: false,
    text: JSON.stringify(INPUT_SCHEMA, null, 2),
    durationMs: 5,
  });
});

test("a failing MCP server's error message reaches the dashboard", async (): Promise<void> => {
  vi.stubEnv("BROODS_ACCOUNT_MANAGE_URL", "https://core.example.invalid");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-service-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> =>
      Response.json(
        apiErrorBody(400, "MCP server dock failed: Unable to connect"),
        { status: 400 },
      ),
    ),
  );
  const { caller, node } = await ownedMcpNode();

  await expect(
    caller.action(api.mcp.saveForNode, {
      ...node,
      nodeLabel: "dock",
      url: "https://mcp.example.com/mcp",
    }),
  ).rejects.toThrow("MCP server dock failed: Unable to connect");
});

async function ownedMcpNode(): Promise<{
  caller: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>;
  node: { projectId: Id<"projects">; stageId: Id<"stages">; nodeId: string };
}> {
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
  const { projectId, stageId } = await t.run(
    async (
      ctx,
    ): Promise<{ projectId: Id<"projects">; stageId: Id<"stages"> }> => {
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
    },
  );

  return {
    caller: caller,
    node: { projectId: projectId, stageId: stageId, nodeId: "mcp-node" },
  };
}
