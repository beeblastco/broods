/// <reference types="vite/client" />
/**
 * Keyset pagination over the config-plane collections: a walk sees every row
 * exactly once, a write landing mid-walk cannot make it skip or repeat one,
 * and a cursor is only good for the collection that issued it.
 */

import { convexTest } from "convex-test";
import { beforeEach, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "fp_acct_test-owner-secret";
const AUTH_ID = "auth_owner";

const pageTest = () => convexTest(schema, modules);

type T = ReturnType<typeof pageTest>;

interface AgentPage {
  agents: { name: string }[];
  hasMore: boolean;
  nextCursor: string | null;
}

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

test("a walk sees every agent exactly once", async () => {
  const t = pageTest();
  await seed(t, ["a", "b", "c", "d", "e"]);

  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const body = await listAgents(t, 2, cursor);
    seen.push(...body.agents.map((agent) => agent.name));
    cursor = body.nextCursor;
  } while (cursor);

  expect(seen).toEqual(["a", "b", "c", "d", "e"]);
});

test("a row inserted during a walk cannot repeat one already seen", async () => {
  const t = pageTest();
  const accountId = await seed(t, ["b", "d", "f"]);

  const first = await listAgents(t, 2, null);
  expect(first.agents.map((agent) => agent.name)).toEqual(["b", "d"]);

  // Sorts ahead of the page just read. Against an offset cursor the next page
  // would start at index 2 of ["a", "b", "d", "f"] and hand back "d" twice.
  await insertAgent(t, accountId, "a");

  const second = await listAgents(t, 2, first.nextCursor);

  expect(second.agents.map((agent) => agent.name)).toEqual(["f"]);
});

test("the last page reports no more and hands back no cursor", async () => {
  const t = pageTest();
  await seed(t, ["a", "b"]);

  const body = await listAgents(t, 10, null);

  expect(body.agents).toHaveLength(2);
  expect(body.hasMore).toBe(false);
  expect(body.nextCursor).toBeNull();
});

test("no limit still answers with the whole collection", async () => {
  const t = pageTest();
  await seed(t, ["a", "b", "c"]);

  const response = await t.fetch("/v1/agents", {
    headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
  });
  const body = (await response.json()) as AgentPage;

  expect(body.agents.map((agent) => agent.name)).toEqual(["a", "b", "c"]);
  expect(body.hasMore).toBe(false);
  expect(body.nextCursor).toBeNull();
});

test("a page boundary on a non-latin-1 name still issues a cursor", async () => {
  const t = pageTest();
  // Sorts ascending, so limit=3 puts the boundary on the CJK name. `btoa`
  // takes Latin-1 only, and Convex's cursor carries the index key it stopped
  // at, so encoding this one used to throw and answer 500.
  await seed(t, [
    "a-agent",
    "b-agent",
    "\u65e5\u672c\u8a9e",
    "\ud83d\udc1d-agent",
  ]);

  const first = await listAgents(t, 3, null);
  expect(first.agents.map((agent) => agent.name)).toEqual([
    "a-agent",
    "b-agent",
    "\u65e5\u672c\u8a9e",
  ]);
  expect(first.nextCursor).toBeTruthy();

  const second = await listAgents(t, 3, first.nextCursor);

  expect(second.agents.map((agent) => agent.name)).toEqual([
    "\ud83d\udc1d-agent",
  ]);
});

test("a cursor from one collection is refused by another", async () => {
  const t = pageTest();
  await seed(t, ["a", "b", "c"]);
  const first = await listAgents(t, 1, null);

  const response = await t.fetch(
    `/v1/roles?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    { headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` } },
  );

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "invalid_cursor", param: "cursor" },
  });
});

test("a limit outside the allowed range is refused", async () => {
  const t = pageTest();
  await seed(t, ["a"]);

  const response = await t.fetch("/v1/agents?limit=0", {
    headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: { code: "invalid_limit", param: "limit" },
  });
});

async function insertAgent(
  t: T,
  accountId: Id<"accounts">,
  name: string,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("agents", {
      accountId: accountId,
      name: name,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function listAgents(
  t: T,
  limit: number,
  cursor: string | null,
): Promise<AgentPage> {
  const query = cursor
    ? `?limit=${limit}&cursor=${encodeURIComponent(cursor)}`
    : `?limit=${limit}`;
  const response = await t.fetch(`/v1/agents${query}`, {
    headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
  });
  expect(response.status).toBe(200);

  return (await response.json()) as AgentPage;
}

async function seed(t: T, agentNames: string[]): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: Date.now(),
    });
    const accountId = await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: await sha256Hex(ACCOUNT_SECRET),
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    for (const name of agentNames) {
      await ctx.db.insert("agents", {
        accountId: accountId,
        name: name,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    return accountId;
  });
}
