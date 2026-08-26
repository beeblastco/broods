/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import {
  deleteAgentConversation,
  listAgentConversations,
  listConversationMessages,
  renameAgentConversation,
  resolveAgentConversationScope,
  CONVERSATION_LIST_LIMIT,
  MESSAGE_PAGE_SIZE,
} from "./model/conversationHistory";

const modules = import.meta.glob("./**/*.ts");

function historyTest() {
  return convexTest(schema, modules);
}

const OWNER_AUTH_ID = "auth_owner";
const OUTSIDER_AUTH_ID = "auth_outsider";

interface Seeded {
  accountId: Id<"accounts">;
  agentId: Id<"agents">;
  configId: Id<"agentConfigs">;
}

async function seed(t: ReturnType<typeof historyTest>): Promise<Seeded> {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const orgId = await ctx.db.insert("orgs", {
      name: "BeeBlast",
      slug: "beeblast",
      ownerAuthId: OWNER_AUTH_ID,
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
      authId: OWNER_AUTH_ID,
      orgId: orgId,
      name: "demo",
      slug: "demo",
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      authId: OWNER_AUTH_ID,
      projectId: projectId,
      name: "Development",
      kind: "development" as const,
      isDefault: true,
      updatedAt: now,
    });
    const agentId = await ctx.db.insert("agents", {
      accountId: accountId,
      name: "vertex-key-test",
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("agentConfigs", {
      authId: OWNER_AUTH_ID,
      name: "vertex-key-test",
      agentId: agentId,
      projectId: projectId,
      stageId: stageId,
      updatedAt: now,
    });

    return { accountId: accountId, agentId: agentId, configId: configId };
  });
}

/** Cursor in the runtime's `{ISO}#{eventId}#{seq}` shape. */
function cursorAt(timestamp: number, seq: number): string {
  return `${new Date(timestamp).toISOString()}#evt#${String(seq).padStart(4, "0")}`;
}

async function seedConversation(
  t: ReturnType<typeof historyTest>,
  seeded: Seeded,
  publicKey: string,
  options: { startAt: number; texts?: string[]; eventCount?: number },
): Promise<string> {
  const scopedKey = `acct:${seeded.accountId}:agent:${seeded.agentId}:api:${publicKey}`;
  const texts = options.texts ?? ["hello there"];
  await t.run(async (ctx) => {
    let seq = 0;
    for (const text of texts) {
      await ctx.db.insert("runtimeConversationEvents", {
        accountId: seeded.accountId,
        conversationKey: scopedKey,
        cursor: cursorAt(options.startAt + seq * 1000, seq),
        event: {
          version: 1,
          sourceEventId: "evt",
          message: { role: "user", content: text },
        },
      });
      seq += 1;
      await ctx.db.insert("runtimeConversationEvents", {
        accountId: seeded.accountId,
        conversationKey: scopedKey,
        cursor: cursorAt(options.startAt + seq * 1000, seq),
        event: {
          version: 1,
          sourceEventId: "evt",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `re: ${text}` }],
          },
        },
      });
      seq += 1;
    }
    for (let extra = seq; extra < (options.eventCount ?? 0); extra += 1) {
      await ctx.db.insert("runtimeConversationEvents", {
        accountId: seeded.accountId,
        conversationKey: scopedKey,
        cursor: cursorAt(options.startAt + extra * 1000, extra),
        event: {
          version: 1,
          sourceEventId: "evt",
          message: { role: "assistant", content: "filler" },
        },
      });
    }
  });

  return scopedKey;
}

describe("resolveAgentConversationScope", () => {
  test("resolves the owner to the agent's scoped key prefix", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    const scope = await t.run(async (ctx) =>
      resolveAgentConversationScope(ctx, OWNER_AUTH_ID, seeded.configId),
    );
    expect(scope).not.toBeNull();
    expect(scope?.keyPrefix).toBe(
      `acct:${seeded.accountId}:agent:${seeded.agentId}:api:`,
    );
  });

  test("a caller from another account gets nothing", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    const scope = await t.run(async (ctx) =>
      resolveAgentConversationScope(ctx, OUTSIDER_AUTH_ID, seeded.configId),
    );
    expect(scope).toBeNull();
  });
});

describe("listAgentConversations", () => {
  test("lists newest activity first with derived titles", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    await seedConversation(t, seeded, "chat-old", {
      startAt: 1_000_000,
      texts: ["first question about databases"],
    });
    await seedConversation(t, seeded, "chat-new", {
      startAt: 2_000_000,
      texts: ["newer question"],
    });

    const result = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        OWNER_AUTH_ID,
        seeded.configId,
      );

      return listAgentConversations(ctx, scope!);
    });

    expect(result.truncated).toBe(false);
    expect(result.conversations.map((c) => c.conversationKey)).toEqual([
      "chat-new",
      "chat-old",
    ]);
    expect(result.conversations[1]?.title).toBe(
      "first question about databases",
    );
    expect(result.conversations[0]?.lastMessageAt).toBeGreaterThan(
      result.conversations[0]?.createdAt ?? 0,
    );
  });

  test("does not list another agent's conversations", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    // Same account, different agent: must not leak into this agent's list.
    const otherAgentId = await t.run(async (ctx) =>
      ctx.db.insert("agents", {
        accountId: seeded.accountId,
        name: "other-agent",
        createdAt: 1,
        updatedAt: 1,
      }),
    );
    await seedConversation(
      t,
      { ...seeded, agentId: otherAgentId },
      "chat-other",
      { startAt: 1_000_000 },
    );

    const result = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        OWNER_AUTH_ID,
        seeded.configId,
      );

      return listAgentConversations(ctx, scope!);
    });
    expect(result.conversations).toEqual([]);
  });

  test("caps the list at the page limit", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    for (let index = 0; index < CONVERSATION_LIST_LIMIT + 3; index += 1) {
      await seedConversation(
        t,
        seeded,
        `chat-${String(index).padStart(3, "0")}`,
        { startAt: 1_000_000 + index * 10_000 },
      );
    }

    const result = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        OWNER_AUTH_ID,
        seeded.configId,
      );

      return listAgentConversations(ctx, scope!);
    });
    expect(result.conversations).toHaveLength(CONVERSATION_LIST_LIMIT);
    expect(result.truncated).toBe(true);
    // Newest activity first: the highest-numbered conversation leads.
    expect(result.conversations[0]?.conversationKey).toBe("chat-052");
  });
});

describe("listConversationMessages", () => {
  test("pages oldest-first with a continue cursor", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    await seedConversation(t, seeded, "chat-long", {
      startAt: 1_000_000,
      texts: ["opener"],
      eventCount: MESSAGE_PAGE_SIZE + 5,
    });

    const { first, second } = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        OWNER_AUTH_ID,
        seeded.configId,
      );
      const firstPage = await listConversationMessages(
        ctx,
        scope!,
        "chat-long",
      );
      const secondPage = await listConversationMessages(
        ctx,
        scope!,
        "chat-long",
        firstPage.continueCursor ?? undefined,
      );

      return { first: firstPage, second: secondPage };
    });

    expect(first.page).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(first.isDone).toBe(false);
    expect(second.isDone).toBe(true);
    expect(second.page).toHaveLength(5);
    // Oldest first: the seeded user opener leads the first page.
    expect(
      (first.page[0]?.event as { message?: { content?: unknown } }).message
        ?.content,
    ).toBe("opener");
  });

  test("another account's scope reads an empty page for the same key", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    await seedConversation(t, seeded, "chat-secret", { startAt: 1_000_000 });

    // A second org/account with its own agent + config, owned by the outsider.
    const other = await t.run(async (ctx) => {
      const now = Date.now();
      const orgId = await ctx.db.insert("orgs", {
        name: "Rival",
        slug: "rival",
        ownerAuthId: OUTSIDER_AUTH_ID,
        plan: "free" as const,
        createdAt: now,
      });
      const accountId = await ctx.db.insert("accounts", {
        orgId: orgId,
        username: "rival",
        secretHash: "hash2",
        status: "active" as const,
        createdAt: now,
        updatedAt: now,
      });
      const projectId = await ctx.db.insert("projects", {
        authId: OUTSIDER_AUTH_ID,
        orgId: orgId,
        name: "rival",
        slug: "rival",
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        authId: OUTSIDER_AUTH_ID,
        projectId: projectId,
        name: "Development",
        kind: "development" as const,
        isDefault: true,
        updatedAt: now,
      });
      const agentId = await ctx.db.insert("agents", {
        accountId: accountId,
        name: "rival-agent",
        createdAt: now,
        updatedAt: now,
      });
      const configId = await ctx.db.insert("agentConfigs", {
        authId: OUTSIDER_AUTH_ID,
        name: "rival-agent",
        agentId: agentId,
        projectId: projectId,
        stageId: stageId,
        updatedAt: now,
      });

      return { configId: configId };
    });

    // The outsider asks for the victim's public key through their own agent:
    // the scoped prefix pins the lookup to their account, so nothing matches.
    const page = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        OUTSIDER_AUTH_ID,
        other.configId,
      );

      return listConversationMessages(ctx, scope!, "chat-secret");
    });
    expect(page.page).toEqual([]);
    expect(page.isDone).toBe(true);
  });
});

describe("rename and delete", () => {
  test("rename persists a title the list then prefers", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    await seedConversation(t, seeded, "chat-a", { startAt: 1_000_000 });

    const titled = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        OWNER_AUTH_ID,
        seeded.configId,
      );
      await renameAgentConversation(ctx, scope!, "chat-a", "  My   task  ");

      return listAgentConversations(ctx, scope!);
    });
    expect(titled.conversations[0]?.title).toBe("My task");
  });

  test("rename of a missing conversation throws", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    await expect(
      t.run(async (ctx) => {
        const scope = await resolveAgentConversationScope(
          ctx,
          OWNER_AUTH_ID,
          seeded.configId,
        );

        return renameAgentConversation(ctx, scope!, "chat-none", "title");
      }),
    ).rejects.toThrow("Conversation not found");
  });

  test("delete removes events, annotation, and harness session", async () => {
    const t = historyTest();
    const seeded = await seed(t);
    const scopedKey = await seedConversation(t, seeded, "chat-gone", {
      startAt: 1_000_000,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("runtimeHarnessSessions", {
        accountId: seeded.accountId,
        conversationKey: scopedKey,
        harnessType: "claude-code" as const,
        sessionId: "sess",
        resumeState: {},
        updatedAt: 1,
      });
      const scope = await resolveAgentConversationScope(
        ctx,
        OWNER_AUTH_ID,
        seeded.configId,
      );
      await renameAgentConversation(ctx, scope!, "chat-gone", "doomed");
    });

    const result = await t.run(async (ctx) => {
      const scope = await resolveAgentConversationScope(
        ctx,
        OWNER_AUTH_ID,
        seeded.configId,
      );
      let deleted = 0;
      for (;;) {
        const batch = await deleteAgentConversation(ctx, scope!, "chat-gone");
        deleted += batch.deleted;
        if (!batch.hasMore) break;
      }
      const events = await ctx.db
        .query("runtimeConversationEvents")
        .withIndex("by_conversationKey_and_cursor", (q) =>
          q.eq("conversationKey", scopedKey),
        )
        .collect();
      const session = await ctx.db
        .query("runtimeHarnessSessions")
        .withIndex("by_conversationKey", (q) =>
          q.eq("conversationKey", scopedKey),
        )
        .unique();
      const annotation = await ctx.db
        .query("conversations")
        .withIndex("by_conversationKey", (q) =>
          q.eq("conversationKey", scopedKey),
        )
        .unique();

      return {
        deleted: deleted,
        events: events,
        session: session,
        annotation: annotation,
      };
    });

    expect(result.deleted).toBe(2);
    expect(result.events).toEqual([]);
    expect(result.session).toBeNull();
    expect(result.annotation).toBeNull();
  });
});
