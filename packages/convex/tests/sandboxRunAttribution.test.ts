/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const attributionTest = () => convexTest(schema, modules);

type T = ReturnType<typeof attributionTest>;
type RunFields = Partial<
  Pick<
    Doc<"sandboxInstances">,
    | "createdByTraceId"
    | "lastUsedTraceId"
    | "createdByTaskId"
    | "lastUsedTaskId"
    | "agentId"
    | "conversationKey"
    | "workspaceName"
    | "workspaceId"
  >
>;

// What core's upsertSandboxInstance sends for one sandbox tool call of a run.
function runOf(n: number): RunFields {
  return {
    createdByTraceId: `trace_${n}`,
    lastUsedTraceId: `trace_${n}`,
    createdByTaskId: `evt_${n}`,
    lastUsedTaskId: `evt_${n}`,
    agentId: "agent_1",
    conversationKey: "acct:a:agent:agent_1:api:chat",
    workspaceName: "notes",
    workspaceId: "ws_notes",
  };
}

test("a run's tool call names its trace, task and agent on the row and on the reserve and resume it caused", async () => {
  const t = attributionTest();
  const accountId = await seedAccount(t);

  await upsert(t, accountId, runOf(1));
  expect(await row(t)).toMatchObject({
    createdByTraceId: "trace_1",
    createdByTaskId: "evt_1",
    lastUsedTraceId: "trace_1",
    lastUsedTaskId: "evt_1",
    agentId: "agent_1",
    conversationKey: "acct:a:agent:agent_1:api:chat",
    workspaceName: "notes",
    workspaceId: "ws_notes",
  });

  // A later run moves the last use and keeps who created it; a running machine logs nothing.
  await upsert(t, accountId, runOf(2));
  expect(await row(t)).toMatchObject({
    createdByTraceId: "trace_1",
    createdByTaskId: "evt_1",
    lastUsedTraceId: "trace_2",
    lastUsedTaskId: "evt_2",
  });

  await t.mutation(internal.sandbox.instances.setStatus, {
    accountId: accountId,
    reservationKey: "key-1",
    status: "suspended",
  });
  await upsert(t, accountId, runOf(3));

  expect(await audit(t)).toEqual([
    {
      action: "reserve",
      actorSource: "agent",
      actorId: "agent_1",
      traceId: "trace_1",
      taskId: "evt_1",
    },
    {
      action: "resume",
      actorSource: "agent",
      actorId: "agent_1",
      traceId: "trace_3",
      taskId: "evt_3",
    },
  ]);
});

test("a write with no run keeps the last run's fields, but what it causes is the service's", async () => {
  const t = attributionTest();
  const accountId = await seedAccount(t);
  await upsert(t, accountId, runOf(1));
  await t.mutation(internal.sandbox.instances.setStatus, {
    accountId: accountId,
    reservationKey: "key-1",
    status: "suspended",
  });

  // A dashboard exec on a suspended machine resumes it with no run behind it.
  await upsert(t, accountId, {});
  expect(await row(t)).toMatchObject({
    lastUsedTraceId: "trace_1",
    agentId: "agent_1",
    conversationKey: "acct:a:agent:agent_1:api:chat",
  });
  // And one on a machine the provider lost launches another.
  await upsert(t, accountId, {}, "key-1", "vm-replaced");

  expect((await audit(t)).slice(1)).toEqual(
    ["resume", "reserve"].map((action) => ({
      action: action,
      actorSource: "service",
      actorId: undefined,
      traceId: undefined,
      taskId: undefined,
    })),
  );
});

async function row(t: T): Promise<Doc<"sandboxInstances"> | null> {
  return await t.run(async (ctx) =>
    ctx.db
      .query("sandboxInstances")
      .withIndex("by_reservationKey", (q) => q.eq("reservationKey", "key-1"))
      .unique(),
  );
}

async function audit(
  t: T,
): Promise<
  Pick<
    Doc<"sandboxAuditEvents">,
    "action" | "actorSource" | "actorId" | "traceId" | "taskId"
  >[]
> {
  const events = await t.run(async (ctx) =>
    ctx.db.query("sandboxAuditEvents").collect(),
  );

  return events.map((event) => ({
    action: event.action,
    actorSource: event.actorSource,
    actorId: event.actorId,
    traceId: event.traceId,
    taskId: event.taskId,
  }));
}

async function seedAccount(t: T): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "acme",
      slug: "acme",
      ownerAuthId: "auth_acme",
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "acme",
      secretHash: "hash",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function upsert(
  t: T,
  accountId: Id<"accounts">,
  run: RunFields,
  reservationKey = "key-1",
  externalId = "vm-1",
): Promise<void> {
  await t.mutation(internal.sandbox.instances.upsert, {
    accountId: accountId,
    provider: "worker",
    reservationKey: reservationKey,
    externalId: externalId,
    name: "box",
    specs: { vcpu: 1, memoryMb: 128, storageGb: 0 },
    idleTimeoutSeconds: 3600,
    ...run,
  });
}
