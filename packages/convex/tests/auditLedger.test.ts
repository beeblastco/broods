/// <reference types="vite/client" />
/**
 * The audit ledger: appends chain, verification catches a tampered row,
 * pruning stops at the export watermark and the head, the config routes
 * serve and gate it, and the sink export signs what it posts.
 */

import { createHmac } from "node:crypto";
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { sha256Hex } from "../model/accountSecrets";
import {
  auditChainHeadRow,
  auditEventHash,
  verifyChainRows,
  type PublicAuditEvent,
} from "../model/auditEvents";
import { signAuditExport } from "../model/auditSinks";
import { stableJson } from "../model/objects";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const ACCOUNT_SECRET = "fp_acct_test-owner-secret";
const AUTH_ID = "auth_owner";
const DAY_MS = 24 * 60 * 60 * 1000;
const SINK_SECRET = "whsec_test";

const ledgerTest = () => convexTest(schema, modules);

type T = ReturnType<typeof ledgerTest>;

beforeEach(() => {
  vi.stubEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET", "test-config-secret");
});

describe("chain", () => {
  test("appends link to the head and verify passes", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");

    const rows = await allRows(t, accountId);
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows[0]?.prevHash).toBe("");
    expect(rows[1]?.prevHash).toBe(rows[0]?.hash);
    expect(await auditEventHash(rows[1]!)).toBe(rows[1]?.hash);
    expect(
      await t.query(internal.audit.ledger.head, { accountId: accountId }),
    ).toEqual({ seq: 2, hash: rows[1]?.hash });
    expect(
      await t.query(internal.audit.ledger.verifyChain, {
        accountId: accountId,
      }),
    ).toEqual({ ok: true, checkedFrom: 1, checkedTo: 2 });
  });

  test("the usage write appends the run's completed row in the same mutation", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    const usage = {
      accountId: accountId,
      endpointId: "ep-1",
      agentId: "agent-1",
      conversationKey: "conv-1",
      taskId: "evt-1#trace-1",
      modelProvider: "anthropic",
      modelId: "claude-test",
      finishedAt: 1_700_000_001_000,
      durationMs: 1000,
      status: "completed" as const,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cachedInputTokens: 10,
      cacheWriteTokens: 2,
      totalTokens: 137,
      runtimeKind: "container",
      runtimeWallMs: 1000,
      runtimeMemoryMb: 512,
      sandboxUsage: [],
      stepCount: 3,
      toolCallCount: 1,
      inputPreview: "rm -rf /",
    };
    await t.mutation(internal.usage.recordTaskUsage, usage);
    // A retried write is deduplicated by taskId and appends nothing.
    await t.mutation(internal.usage.recordTaskUsage, usage);

    const rows = await allRows(t, accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      seq: 1,
      traceId: "trace-1",
      actor: { kind: "agent", agentId: "agent-1" },
      action: "run.completed",
      resource: { kind: "run", id: "evt-1" },
      summary: "Run completed after 1000ms",
    });
    expect(JSON.parse(rows[0]!.detailsJson ?? "{}")).toEqual({
      status: "completed",
      startedAt: 1_700_000_000_000,
      durationMs: 1000,
      modelProvider: "anthropic",
      modelId: "claude-test",
      stepCount: 3,
      toolCallCount: 1,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 137,
    });
    expect(rows[0]?.detailsJson).not.toContain("rm -rf");
  });

  // A receiver recomputing the hash in another language sorts keys by code
  // point; locale collation would put "a" before "B".
  test("the hash input sorts keys by code point", () => {
    expect(stableJson({ b: 1, B: 2, a: { d: 1, C: 2 } })).toBe(
      '{"B":2,"a":{"C":2,"d":1},"b":1}',
    );
  });

  test("verify refuses a range that starts at 0 or runs backwards", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");

    for (const query of ["fromSeq=0", "toSeq=0", "fromSeq=5&toSeq=2"]) {
      const response = await t.fetch(`/v1/audit/verify?${query}`, {
        headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
      });
      expect(response.status).toBe(400);
    }
  });

  test("a row edited in place is reported at its seq", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");
    await record(t, accountId, "third");

    const rows = await allRows(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.patch(rows[1]!._id, { summary: "edited" });
    });

    expect(
      await t.query(internal.audit.ledger.verifyChain, {
        accountId: accountId,
      }),
    ).toEqual({ ok: false, brokenAtSeq: 2, checkedFrom: 1, checkedTo: 3 });
  });

  test("a row re-hashed to hide an edit breaks the next link", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");
    await record(t, accountId, "third");

    const rows = await allRows(t, accountId);
    const forged = { ...rows[1]!, summary: "edited" };
    await t.run(async (ctx) => {
      await ctx.db.patch(rows[1]!._id, {
        summary: forged.summary,
        hash: await auditEventHash(forged),
      });
    });

    expect(
      await t.query(internal.audit.ledger.verifyChain, {
        accountId: accountId,
      }),
    ).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });

  test("a dropped tail is reported at the first missing seq", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");

    const rows = await allRows(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.delete(rows[1]!._id);
    });

    expect(
      await t.query(internal.audit.ledger.verifyChain, {
        accountId: accountId,
      }),
    ).toEqual({ ok: false, brokenAtSeq: 2, checkedFrom: 1, checkedTo: 1 });
  });

  test("verifyChainRows checks the first link only when the anchor is known", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");
    const rows = await allRows(t, accountId);

    expect(await verifyChainRows(rows.slice(1))).toEqual({ ok: true });
    expect(await verifyChainRows(rows.slice(1), "wrong")).toEqual({
      ok: false,
      brokenAtSeq: 2,
    });
  });
});

describe("prune", () => {
  test("deletes only exported rows past retention and keeps the head", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    for (let index = 0; index < 4; index += 1) {
      await record(t, accountId, `row ${index + 1}`);
    }
    await backdate(t, accountId, Date.now() - 100 * DAY_MS);

    // No sink: nothing is exported, so nothing is pruned however old.
    await t.mutation(internal.audit.ledger.pruneExpired, {});
    expect((await allRows(t, accountId)).length).toBe(4);

    const sinkId = await seedSink(t, accountId);
    await t.mutation(internal.audit.sinks.markExported, {
      sinkId: sinkId,
      exportedSeq: 3,
    });
    await t.mutation(internal.audit.ledger.pruneExpired, {});
    expect((await allRows(t, accountId)).map((row) => row.seq)).toEqual([4]);

    // Everything exported, the head still stays.
    await t.mutation(internal.audit.sinks.markExported, {
      sinkId: sinkId,
      exportedSeq: 4,
    });
    await t.mutation(internal.audit.ledger.pruneExpired, {});
    expect((await allRows(t, accountId)).map((row) => row.seq)).toEqual([4]);
    expect(
      await t.query(internal.audit.ledger.verifyChain, {
        accountId: accountId,
      }),
    ).toEqual({ ok: true, checkedFrom: 4, checkedTo: 4 });
  });

  test("honours the account's own retention window", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");
    const rows = await allRows(t, accountId);
    await t.run(async (ctx) => {
      await ctx.db.patch(rows[0]!._id, { at: Date.now() - 10 * DAY_MS });
      await ctx.db.patch(accountId, { auditRetentionDays: 7 });
    });
    const sinkId = await seedSink(t, accountId);
    await t.mutation(internal.audit.sinks.markExported, {
      sinkId: sinkId,
      exportedSeq: 2,
    });

    await t.mutation(internal.audit.ledger.pruneExpired, {});

    expect((await allRows(t, accountId)).map((row) => row.seq)).toEqual([2]);
  });
});

describe("routes", () => {
  test("lists rows since a seq with the head, and verifies", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");
    await record(t, accountId, "third");

    const response = await t.fetch("/v1/audit?since=1&limit=1", {
      headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
    });
    const page: {
      events: PublicAuditEvent[];
      nextSince: number;
      head: { seq: number; hash: string };
    } = await response.json();
    expect(page.events.map((event) => event.seq)).toEqual([2]);
    expect(page.nextSince).toBe(2);
    expect(page.head.seq).toBe(3);
    expect(page.events[0]).not.toHaveProperty("_id");

    const verify = await t.fetch("/v1/audit/verify?fromSeq=2", {
      headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
    });
    expect(await verify.json()).toEqual({
      ok: true,
      checkedFrom: 2,
      checkedTo: 3,
    });

    const bad = await t.fetch("/v1/audit?limit=0", {
      headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
    });
    expect(bad.status).toBe(400);
  });

  test("a role needs audit:read to list and audit:write to set the sink", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    const reader = await roleSession(t, accountId, ["audit:read"]);

    const list = await t.fetch("/v1/audit", {
      headers: { Authorization: `Bearer ${reader}` },
    });
    expect(list.status).toBe(200);

    const put = await t.fetch("/v1/audit/sink", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${reader}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url: "https://sink.example/audit", secret: "s" }),
    });
    expect(put.status).toBe(403);

    const other = await roleSession(t, accountId, ["agents:read"]);
    const denied = await t.fetch("/v1/audit", {
      headers: { Authorization: `Bearer ${other}` },
    });
    expect(denied.status).toBe(403);
  });

  test("the sink refuses private hosts and plain http, then round-trips", async () => {
    const t = ledgerTest();
    await seedAccount(t);
    for (const url of [
      "http://sink.example/audit",
      "https://localhost/audit",
      "https://10.0.0.5/audit",
    ]) {
      const response = await putSink(t, url);
      expect(response.status, url).toBe(400);
    }

    const created = await putSink(t, "https://sink.example/audit");
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      kind: "webhook",
      url: "https://sink.example/audit",
      exportedSeq: 0,
    });

    const read = await t.fetch("/v1/audit/sink", {
      headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
    });
    const body: Record<string, unknown> = await read.json();
    expect(body).not.toHaveProperty("encryptedSecret");
    expect(JSON.stringify(body)).not.toContain(SINK_SECRET);

    const deleted = await t.fetch("/v1/audit/sink", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
    });
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(
      (
        await t.fetch("/v1/audit/sink", {
          headers: { Authorization: `Bearer ${ACCOUNT_SECRET}` },
        })
      ).status,
    ).toBe(404);
  });
});

describe("export", () => {
  test("signs the batch, advances the watermark on 2xx, records an error otherwise", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    await record(t, accountId, "first");
    await record(t, accountId, "second");
    // Setting the sink is itself a ledger row (seq 3).
    expect((await putSink(t, "https://sink.example/audit")).status).toBe(200);

    const posted: Array<{ url: string; body: string; signature: string }> = [];
    let status = 200;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit): Promise<Response> => {
        const headers = new Headers(init.headers);
        posted.push({
          url: url,
          body: typeof init.body === "string" ? init.body : "",
          signature: headers.get("X-Broods-Signature") ?? "",
        });

        return new Response("", { status: status });
      }),
    );

    await t.action(internal.audit.sinks.exportDue, {});

    expect(posted).toHaveLength(1);
    expect(posted[0]?.url).toBe("https://sink.example/audit");
    const events: PublicAuditEvent[] = JSON.parse(posted[0]!.body);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(posted[0]?.signature).toBe(
      `sha256=${createHmac("sha256", SINK_SECRET).update(posted[0]!.body).digest("hex")}`,
    );
    expect(await sink(t, accountId)).toMatchObject({ exportedSeq: 3 });

    // Nothing new: no delivery.
    await t.action(internal.audit.sinks.exportDue, {});
    expect(posted).toHaveLength(1);

    await record(t, accountId, "fourth");
    status = 503;
    await t.action(internal.audit.sinks.exportDue, {});
    expect(posted).toHaveLength(2);
    expect(await sink(t, accountId)).toMatchObject({
      exportedSeq: 3,
      lastError: "HTTP 503",
    });
  });

  test("one tick drains a backlog larger than one batch", async () => {
    const t = ledgerTest();
    const accountId = await seedAccount(t);
    for (let index = 0; index < 200; index += 1) {
      await record(t, accountId, `row ${index}`);
    }
    // Setting the sink is row 201, one past a full batch.
    expect((await putSink(t, "https://sink.example/audit")).status).toBe(200);
    const batchSizes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit): Promise<Response> => {
        const rows: PublicAuditEvent[] = JSON.parse(
          typeof init.body === "string" ? init.body : "[]",
        );
        batchSizes.push(rows.length);

        return new Response("", { status: 200 });
      }),
    );

    await t.action(internal.audit.sinks.exportDue, {});

    expect(batchSizes).toEqual([200, 1]);
    expect(await sink(t, accountId)).toMatchObject({ exportedSeq: 201 });
  });

  test("signAuditExport matches an HMAC-SHA256 the receiver computes", async () => {
    const body = JSON.stringify([{ seq: 1 }]);

    expect(await signAuditExport("secret", body)).toBe(
      `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`,
    );
  });
});

/** Age every row to `at`, re-chaining hashes so the ledger still verifies. */
async function backdate(
  t: T,
  accountId: Id<"accounts">,
  at: number,
): Promise<void> {
  const rows = await allRows(t, accountId);
  let prevHash = "";
  const rechained: Array<
    Pick<Doc<"auditEvents">, "_id" | "prevHash" | "hash">
  > = [];
  for (const row of rows) {
    const hash = await auditEventHash({ ...row, at: at, prevHash: prevHash });
    rechained.push({ _id: row._id, prevHash: prevHash, hash: hash });
    prevHash = hash;
  }
  await t.run(async (ctx) => {
    for (const row of rechained) {
      await ctx.db.patch(row._id, {
        at: at,
        prevHash: row.prevHash,
        hash: row.hash,
      });
    }
    const head = await auditChainHeadRow(ctx.db, accountId);
    if (head) await ctx.db.patch(head._id, { hash: prevHash });
  });
}

async function allRows(
  t: T,
  accountId: Id<"accounts">,
): Promise<Doc<"auditEvents">[]> {
  return await t.run(async (ctx) => {
    return await ctx.db
      .query("auditEvents")
      .withIndex("by_accountId_and_seq", (q) => q.eq("accountId", accountId))
      .collect();
  });
}

async function putSink(t: T, url: string): Promise<Response> {
  return await t.fetch("/v1/audit/sink", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${ACCOUNT_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url: url, secret: SINK_SECRET }),
  });
}

async function record(
  t: T,
  accountId: Id<"accounts">,
  summary: string,
): Promise<void> {
  await t.mutation(internal.audit.ledger.record, {
    accountId: accountId,
    actor: { kind: "apiAccountSecret", id: accountId },
    action: "updated",
    resource: { kind: "agent", id: "agent_1", name: "bot" },
    summary: summary,
  });
}

async function roleSession(
  t: T,
  accountId: Id<"accounts">,
  actions: Array<"audit:read" | "agents:read">,
): Promise<string> {
  const created = await t.mutation(internal.account.roles.createInternal, {
    accountId: accountId,
    name: `role-${actions.join("-")}`,
    policy: {
      version: 1,
      rules: [{ id: "r", effect: "allow", actions: actions }],
    },
  });
  const response = await t.fetch("/v1/account/assume-role", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ACCOUNT_SECRET}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roleId: created.roleId }),
  });
  const body: { token: string } = await response.json();

  return body.token;
}

async function seedAccount(t: T): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: AUTH_ID,
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: await sha256Hex(ACCOUNT_SECRET),
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedSink(
  t: T,
  accountId: Id<"accounts">,
): Promise<Id<"auditSinks">> {
  const row = await t.mutation(internal.audit.sinks.put, {
    accountId: accountId,
    url: "https://sink.example/audit",
    encryptedSecret: "x",
    secretIv: "x",
    secretTag: "x",
  });

  return row._id;
}

async function sink(
  t: T,
  accountId: Id<"accounts">,
): Promise<Doc<"auditSinks"> | null> {
  return await t.query(internal.audit.sinks.get, { accountId: accountId });
}
