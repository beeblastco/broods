/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const NOW = Date.UTC(2026, 10, 4, 12);
const KEY = "acct:workspace-key";
const SPECS = { vcpu: 1, memoryMb: 2048, storageGb: 8 };

type Provider = Doc<"sandboxInstances">["provider"];

const releaseTest = () => convexTest(schema, modules);

type T = ReturnType<typeof releaseTest>;

afterEach(() => {
  vi.useRealTimers();
});

test.each(["cloudflare", "worker", "lambda"] as const)(
  "a %s command answered after its machine was released does not bring the row back",
  async (provider) => {
    vi.useFakeTimers({ now: NOW - 1000 });
    const t = releaseTest();
    const accountId = await seedAccount(t);
    vi.setSystemTime(NOW);
    await reserve(t, accountId, provider, "box-1");
    expect(await mirror(t, accountId, provider, "box-1")).toBe(true);
    expect((await row(t))?.externalId).toBe("box-1");

    vi.setSystemTime(NOW + 60_000);
    await release(t, accountId, provider, "box-1");
    const billed = await meter(t);
    // The exec ran before the delete, but its answer reached core after the removal. Core
    // reads the refusal, so it does not count the refresh as sent.
    expect(await mirror(t, accountId, provider, "box-1")).toBe(false);

    expect(await row(t)).toBeNull();
    vi.setSystemTime(NOW + 30 * 60_000);
    await t.mutation(internal.sandbox.instances.accrueRecent, {
      now: NOW + 30 * 60_000,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await meter(t)).toEqual(billed);
  },
);

test("a freshly reserved machine's first write creates its row and bills its launch", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = releaseTest();
  const accountId = await seedAccount(t);
  await reserve(t, accountId, "lambda", "vm-1");
  await mirror(t, accountId, "lambda", "vm-1");

  expect(await row(t)).toMatchObject({
    externalId: "vm-1",
    status: "running",
  });
  expect((await meter(t))?.sandboxSnapshotGb).toBeGreaterThan(0);
});

test("a key reserved again keeps its row on the new machine when the old one's late write lands", async () => {
  vi.useFakeTimers({ now: NOW - 1000 });
  const t = releaseTest();
  const accountId = await seedAccount(t);
  vi.setSystemTime(NOW);
  await reserve(t, accountId, "cloudflare", "cf-1");
  await mirror(t, accountId, "cloudflare", "cf-1");
  await release(t, accountId, "cloudflare", "cf-1");
  await reserve(t, accountId, "cloudflare", "cf-2");
  await mirror(t, accountId, "cloudflare", "cf-2");
  vi.setSystemTime(NOW + 10_000);
  const before = { row: await row(t), meter: await meter(t) };

  await mirror(t, accountId, "cloudflare", "cf-1");

  expect(before.row?.externalId).toBe("cf-2");
  expect({ row: await row(t), meter: await meter(t) }).toEqual(before);
});

test("a teardown retried under another key removes the machine's row and stops its billing", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = releaseTest();
  const accountId = await seedAccount(t);
  await reserve(t, accountId, "e2b", "sbx-1");
  await mirror(t, accountId, "e2b", "sbx-1");

  vi.setSystemTime(NOW + 60_000);
  await t.mutation(internal.sandbox.instances.remove, {
    accountId: accountId,
    reservationKey: "teardown:sbx-1",
    externalId: "sbx-1",
  });
  const billed = await meter(t);

  expect(await row(t)).toBeNull();
  vi.setSystemTime(NOW + 30 * 60_000);
  await t.mutation(internal.sandbox.instances.accrueRecent, {
    now: NOW + 30 * 60_000,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await meter(t)).toEqual(billed);
});

test("an ephemeral row needs no reservation", async () => {
  vi.useFakeTimers({ now: NOW });
  const t = releaseTest();
  const accountId = await seedAccount(t);
  await t.mutation(internal.sandbox.instances.upsert, {
    accountId: accountId,
    provider: "cloudflare",
    reservationKey: "fp-e-1",
    externalId: "fp-e-1",
    name: "box",
    specs: SPECS,
    ephemeral: true,
  });

  expect(await row(t)).toMatchObject({ externalId: "fp-e-1", ephemeral: true });
});

async function meter(t: T): Promise<Doc<"usageMeters"> | null> {
  return await t.run(async (ctx) => ctx.db.query("usageMeters").unique());
}

async function mirror(
  t: T,
  accountId: Id<"accounts">,
  provider: Provider,
  externalId: string,
): Promise<boolean> {
  return await t.mutation(internal.sandbox.instances.upsert, {
    accountId: accountId,
    provider: provider,
    reservationKey: KEY,
    externalId: externalId,
    name: "box",
    specs: SPECS,
  });
}

// Core's order: the provider delete, then the reservation, then the caller's row removal.
async function release(
  t: T,
  accountId: Id<"accounts">,
  provider: Provider,
  externalId: string,
): Promise<void> {
  expect(
    await t.mutation(internal.runtime.deleteSandboxReservation, {
      provider: provider,
      reservationKey: KEY,
      expectedExternalId: externalId,
      accountId: accountId,
    }),
  ).toBe(true);
  await t.mutation(internal.sandbox.instances.remove, {
    accountId: accountId,
    reservationKey: KEY,
  });
}

async function reserve(
  t: T,
  accountId: Id<"accounts">,
  provider: Provider,
  externalId: string,
): Promise<void> {
  expect(
    await t.mutation(internal.runtime.claimSandboxReservation, {
      provider: provider,
      reservationKey: KEY,
      externalId: externalId,
      accountId: accountId,
    }),
  ).toBe(true);
}

async function row(t: T): Promise<Doc<"sandboxInstances"> | null> {
  return await t.run(async (ctx) => ctx.db.query("sandboxInstances").unique());
}

async function seedAccount(t: T): Promise<Id<"accounts">> {
  return await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("orgs", {
      name: "beeblast",
      slug: "beeblast",
      ownerAuthId: "auth_beeblast",
      plan: "free" as const,
      createdAt: Date.now(),
    });

    return await ctx.db.insert("accounts", {
      orgId: orgId,
      username: "beeblast",
      secretHash: "hash",
      status: "active" as const,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}
