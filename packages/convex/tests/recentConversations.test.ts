/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

test("listRecentConversations returns direct-API conversations with the key prefix, last active first", async () => {
  const tt = convexTest(schema, modules);
  const accountId = await tt.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "acme",
      slug: "acme",
      ownerAuthId: "auth_owner@example.com",
      plan: "free" as const,
      createdAt: 1,
    });
    const account = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "acme",
      secretHash: "hash-recent-conversations",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    });
    const keys: [string, number][] = [
      [`acct:${account}:agent:a1:api:mcp-older`, 10],
      [`acct:${account}:agent:a1:api:mcp-newer`, 30],
      [`acct:${account}:agent:a1:slack:C1`, 20],
      [`acct:${account}:agent:a1:api:bsu:u1:chat`, 40],
      [`acct:${account}:agent:a1:api:subagent-persistent-x`, 50],
    ];
    for (const [conversationKey, updatedAt] of keys) {
      await ctx.db.insert("runtimeConversationCoordinators", {
        accountId: account,
        agentId: "a1",
        conversationKey: conversationKey,
        nextSequence: 1,
        ownerGeneration: 0,
        queuedCount: 0,
        queuedBytes: 0,
        updatedAt: updatedAt,
      });
    }

    return account;
  });

  const listed = await tt.query(internal.runtime.listRecentConversations, {
    accountId: accountId,
    keyPrefix: "mcp-",
  });

  expect(listed.map(({ conversationKey }) => conversationKey)).toEqual([
    `acct:${accountId}:agent:a1:api:mcp-newer`,
    `acct:${accountId}:agent:a1:api:mcp-older`,
  ]);
});
