/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  mergeDeliverables,
  readConversationDeliverables,
  recordConversationDeliverables,
  resolveAgentConversationScope,
} from "./model/conversationHistory";

const modules = import.meta.glob("./**/*.ts");

describe("mergeDeliverables", () => {
  test("appends new files, newest replaces same path, ordered by foundAt", () => {
    const merged = mergeDeliverables(
      [
        { path: "a.md", workspaceId: "w1", foundAt: 1 },
        { path: "b.md", workspaceId: "w1", foundAt: 2, sizeBytes: 10 },
      ],
      [
        { path: "b.md", workspaceId: "w1", foundAt: 5, sizeBytes: 20 },
        { path: "c.md", workspaceId: "w1", foundAt: 3 },
      ],
    );
    expect(merged).toEqual([
      { path: "a.md", workspaceId: "w1", foundAt: 1 },
      { path: "c.md", workspaceId: "w1", foundAt: 3 },
      { path: "b.md", workspaceId: "w1", foundAt: 5, sizeBytes: 20 },
    ]);
  });

  test("same path in a different workspace is a different deliverable", () => {
    const merged = mergeDeliverables(
      [{ path: "a.md", workspaceId: "w1", foundAt: 1 }],
      [{ path: "a.md", workspaceId: "w2", foundAt: 2 }],
    );
    expect(merged).toHaveLength(2);
  });
});

describe("record/read deliverables on the annotation row", () => {
  test("round-trips and merges across runs; cross-account reads nothing", async () => {
    const t = convexTest(schema, modules);
    const seeded = await t.run(async (ctx) => {
      const now = Date.now();
      const orgId = await ctx.db.insert("orgs", {
        name: "BeeBlast",
        slug: "beeblast",
        ownerAuthId: "auth_owner",
        plan: "free" as const,
        createdAt: now,
      });
      const accountId = await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "beeblast",
        secretHash: "hash",
        status: "active" as const,
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
        kind: "development" as const,
        isDefault: true,
        updatedAt: now,
      });
      const agentId = await ctx.db.insert("agents", {
        accountId: accountId,
        name: "a",
        createdAt: now,
        updatedAt: now,
      });
      const configId = await ctx.db.insert("agentConfigs", {
        authId: "auth_owner",
        name: "a",
        agentId: agentId,
        projectId: projectId,
        stageId: stageId,
        updatedAt: now,
      });
      await ctx.db.insert("runtimeConversationEvents", {
        accountId: accountId,
        conversationKey: `acct:${accountId}:agent:${agentId}:api:chat-1`,
        cursor: `${new Date(now).toISOString()}#evt#0000`,
        event: {
          version: 1,
          sourceEventId: "evt",
          message: { role: "user", content: "hi" },
        },
      });

      return { configId: configId as Id<"agentConfigs"> };
    });

    const result = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        "auth_owner",
        seeded.configId,
      );
      await recordConversationDeliverables(ctx, scope!, "chat-1", [
        { path: "report.md", workspaceId: "w1", foundAt: 10 },
      ]);
      await recordConversationDeliverables(ctx, scope!, "chat-1", [
        { path: "summary.md", workspaceId: "w1", foundAt: 20, sizeBytes: 5 },
      ]);

      return readConversationDeliverables(ctx, scope!, "chat-1");
    });
    expect(result).toEqual([
      { path: "report.md", workspaceId: "w1", foundAt: 10 },
      { path: "summary.md", workspaceId: "w1", foundAt: 20, sizeBytes: 5 },
    ]);

    const outsider = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        "auth_other",
        seeded.configId,
      );

      return scope;
    });
    expect(outsider).toBeNull();
  });
});
