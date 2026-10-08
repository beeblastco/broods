/// <reference types="vite/client" />
/**
 * A sandbox row's verified size: `setSpecs` patches in a size a provider reports
 * after the row exists, and `upsert` keeps a verified size across a reconnect
 * that knows none.
 */

import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const NOW = Date.UTC(2026, 8, 23, 12);
const CONFIG_SPECS = { vcpu: 0.5, memoryMb: 1024, storageGb: 8 };
const REPORTED = { vcpu: 2, memoryMb: 4096 };

const specsTest = () => convexTest(schema, modules);

type T = ReturnType<typeof specsTest>;

afterEach(() => {
  vi.useRealTimers();
});

test("setSpecs bills the time so far at the old size, then only patches the same live machine", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = specsTest();
  const accountId = await seedAccount(t, "beeblast");
  const otherId = await seedAccount(t, "other");
  await upsert(t, accountId, "vm-1", { specs: CONFIG_SPECS });

  vi.setSystemTime(NOW + 10 * 60 * 1000);
  await t.mutation(internal.sandbox.instances.setSpecs, {
    accountId: accountId,
    reservationKey: "key-1",
    externalId: "vm-1",
    specs: REPORTED,
  });

  const meter = await t.run(async (ctx) =>
    ctx.db.query("usageMeters").unique(),
  );
  // Ten minutes at the config's 0.5 vCPU / 1 GB, before the report landed.
  expect(meter).toMatchObject({
    sandboxVcpuSeconds: 300,
    sandboxGbSeconds: 600,
  });
  expect(await row(t)).toMatchObject({ specs: REPORTED, specsVerified: true });

  const late = { vcpu: 8, memoryMb: 16384 };
  for (const args of [
    { accountId: otherId, externalId: "vm-1" },
    { accountId: accountId, externalId: "vm-2" },
  ]) {
    await t.mutation(internal.sandbox.instances.setSpecs, {
      ...args,
      reservationKey: "key-1",
      specs: late,
    });
  }
  expect((await row(t))?.specs).toEqual(REPORTED);

  await t.mutation(internal.sandbox.instances.remove, {
    accountId: accountId,
    reservationKey: "key-1",
  });
  await t.mutation(internal.sandbox.instances.setSpecs, {
    accountId: accountId,
    reservationKey: "key-1",
    externalId: "vm-1",
    specs: late,
  });
  expect(await row(t)).toBeNull();
});

test("a reconnect without a size keeps the verified one, and a new machine starts unverified", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = specsTest();
  const accountId = await seedAccount(t, "beeblast");
  await upsert(t, accountId, "vm-1", {
    specs: REPORTED,
    specsVerified: true,
  });

  await upsert(t, accountId, "vm-1", { specs: CONFIG_SPECS });
  expect(await row(t)).toMatchObject({ specs: REPORTED, specsVerified: true });

  await upsert(t, accountId, "vm-2", { specs: CONFIG_SPECS });
  const replaced = await row(t);
  expect(replaced?.specs).toEqual(CONFIG_SPECS);
  expect(replaced?.specsVerified).toBeUndefined();
});

// The one sandbox row these tests write.
async function row(t: T): Promise<Doc<"sandboxInstances"> | null> {
  return await t.run(async (ctx) => ctx.db.query("sandboxInstances").unique());
}

async function seedAccount(t: T, name: string): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: name,
      slug: name,
      ownerAuthId: `auth_${name}`,
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: name,
      secretHash: "hash",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

// An e2b row under one reservation key, idling up to an hour.
async function upsert(
  t: T,
  accountId: Id<"accounts">,
  externalId: string,
  size: Pick<Doc<"sandboxInstances">, "specs" | "specsVerified">,
): Promise<void> {
  await t.mutation(internal.sandbox.instances.upsert, {
    accountId: accountId,
    provider: "e2b",
    reservationKey: "key-1",
    externalId: externalId,
    name: "box",
    idleTimeoutSeconds: 3600,
    ...size,
  });
}
