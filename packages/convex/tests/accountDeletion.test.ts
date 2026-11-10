/// <reference types="vite/client" />
import workosTest from "@convex-dev/workos-authkit/test";
import { createFunctionHandle } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAVING = "auth_leaving";
const STAYING = "auth_staying";

const caller = vi.hoisted(() => ({ authId: "auth_leaving" }));
const deleteUser = vi.hoisted(() =>
  vi.fn(async (_authId: string): Promise<void> => {}),
);

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  authKit: {
    getAuthUser: async () => ({ id: caller.authId }),
    registerRoutes: () => undefined,
    workos: { userManagement: { deleteUser: deleteUser } },
  },
}));

const modules = import.meta.glob("../**/*.ts");

beforeEach((): void => {
  vi.useFakeTimers();
  vi.stubEnv("BROODS_ACCOUNT_MANAGE_URL", "https://core.test");
  vi.stubEnv("ADMIN_ACCOUNT_SECRET", "secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> => new Response(null, { status: 204 })),
  );
});

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  deleteUser.mockReset();
});

test("a past-due account deletion removes the user and their org, a cancelled one stays", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const leaving = await seedSoleOwner(t, LEAVING);
  const staying = await seedSoleOwner(t, STAYING);
  await requestDeletion(t, [LEAVING, STAYING]);
  await t.mutation(internal.user.cancelAccountDeletion, { authId: STAYING });

  await sweep(t);
  expect(await t.run(async (ctx) => ctx.db.get(leaving.userId))).not.toBe(null);

  vi.advanceTimersByTime(8 * DAY_MS);
  await sweep(t);

  expect(deleteUser.mock.calls).toEqual([[LEAVING]]);
  expect(await t.run(async (ctx) => ctx.db.get(leaving.userId))).toBe(null);
  expect(await t.run(async (ctx) => ctx.db.get(leaving.orgId))).toBe(null);
  const kept = await t.run(async (ctx) => ctx.db.get(staying.userId));
  expect(kept?.deletionScheduledFor).toBe(undefined);
  expect(await t.run(async (ctx) => ctx.db.get(staying.orgId))).not.toBe(null);
});

test("a cancel that lands while the sweep runs is refused, never silently ignored", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  await seedSoleOwner(t, LEAVING);
  await seedSoleOwner(t, STAYING);
  await requestDeletion(t, [LEAVING, STAYING]);
  const cancels: Promise<string>[] = [];
  deleteUser.mockImplementation(async (authId: string): Promise<void> => {
    if (authId !== LEAVING) return;
    cancels.push(
      t.mutation(internal.user.cancelAccountDeletion, { authId: STAYING }).then(
        (): string => "cancelled",
        (error: Error): string => error.message,
      ),
    );
  });

  vi.advanceTimersByTime(8 * DAY_MS);
  await sweep(t);

  expect(await Promise.all(cancels)).toEqual([
    expect.stringMatching(/already started/),
  ]);
  expect(deleteUser.mock.calls).toEqual([[LEAVING], [STAYING]]);
});

test("an identity WorkOS no longer has is still torn down", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const leaving = await seedSoleOwner(t, LEAVING);
  await requestDeletion(t, [LEAVING]);
  deleteUser.mockRejectedValueOnce(
    Object.assign(new Error("User not found"), { name: "NotFoundException" }),
  );

  vi.advanceTimersByTime(8 * DAY_MS);
  await sweep(t);

  expect(await t.run(async (ctx) => ctx.db.get(leaving.userId))).toBe(null);
  expect(await t.run(async (ctx) => ctx.db.get(leaving.orgId))).toBe(null);
});

test("a failed identity delete keeps the account and the next sweep retries it", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const leaving = await seedSoleOwner(t, LEAVING);
  await requestDeletion(t, [LEAVING]);
  deleteUser.mockRejectedValueOnce(new Error("WorkOS unavailable"));

  vi.advanceTimersByTime(8 * DAY_MS);
  await sweep(t);
  const kept = await t.run(async (ctx) => ctx.db.get(leaving.userId));
  expect(kept?.workosDeletionRequestedAt).toBe(undefined);
  expect(kept?.deletionScheduledFor).toEqual(expect.any(Number));

  vi.advanceTimersByTime(DAY_MS / 24);
  await sweep(t);

  expect(deleteUser.mock.calls).toEqual([[LEAVING], [LEAVING]]);
  expect(await t.run(async (ctx) => ctx.db.get(leaving.userId))).toBe(null);
});

test("the user.deleted webhook that follows the sweep queues no second teardown", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  workosTest.register(t);
  await seedSoleOwner(t, LEAVING);
  await requestDeletion(t, [LEAVING]);
  const onEventHandle = await t.run(
    async (): Promise<string> =>
      await createFunctionHandle(internal.auth.authKitEvent),
  );
  deleteUser.mockImplementation(async (authId: string): Promise<void> => {
    await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
      event: {
        id: "event_deleted",
        createdAt: "2026-11-03T00:00:00.000Z",
        event: "user.deleted",
        data: { id: authId },
      },
      onEventHandle: onEventHandle,
    });
  });

  vi.advanceTimersByTime(8 * DAY_MS);
  await sweep(t);

  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(
    scheduled.filter(
      ({ name }) => name === "org/workosUserDeletionCleanup:run",
    ),
  ).toHaveLength(1);
});

test("one sweep handles a bounded batch and the next one picks up the rest", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    for (let index = 0; index < 26; index += 1) {
      await ctx.db.insert("users", {
        authId: `auth_${index}`,
        email: `user${index}@example.com`,
        name: `User ${index}`,
        plan: "free",
        deletionScheduledFor: Date.now(),
      });
    }
  });

  vi.advanceTimersByTime(DAY_MS);
  await sweep(t);
  expect(deleteUser).toHaveBeenCalledTimes(25);

  await sweep(t);
  expect(deleteUser).toHaveBeenCalledTimes(26);
  expect(await t.run(async (ctx) => ctx.db.query("users").collect())).toEqual(
    [],
  );
});

test("an owner of an org with other members cannot request deletion", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const owner = await seedSoleOwner(t, LEAVING);
  await addMember(t, owner.orgId, STAYING);

  caller.authId = LEAVING;
  await expect(t.mutation(api.user.requestAccountDeletion, {})).rejects.toThrow(
    /other members/,
  );
});

test("a member who joins after the request keeps the owner's account, and the request is dropped", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  const owner = await seedSoleOwner(t, LEAVING);
  await requestDeletion(t, [LEAVING]);
  await addMember(t, owner.orgId, STAYING);

  vi.advanceTimersByTime(8 * DAY_MS);
  await sweep(t);

  expect(deleteUser).not.toHaveBeenCalled();
  const kept = await t.run(async (ctx) => ctx.db.get(owner.userId));
  expect(kept?.deletionScheduledFor).toBe(undefined);
  expect(kept?.workosDeletionRequestedAt).toBe(undefined);
  expect(await t.run(async (ctx) => ctx.db.get(owner.orgId))).not.toBe(null);
});

test("skipped shared owners leave the due range, so they cannot starve a later request", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  for (let index = 0; index < 25; index += 1) {
    const owner = await seedSoleOwner(t, `auth_shared_${index}`);
    await t.run(async (ctx) =>
      ctx.db.patch(owner.userId, { deletionScheduledFor: Date.now() }),
    );
    await addMember(t, owner.orgId, `auth_member_${index}`);
  }
  vi.advanceTimersByTime(1);
  const leaving = await seedSoleOwner(t, LEAVING);
  await t.run(async (ctx) =>
    ctx.db.patch(leaving.userId, { deletionScheduledFor: Date.now() }),
  );

  vi.advanceTimersByTime(DAY_MS);
  await sweep(t);
  vi.advanceTimersByTime(DAY_MS / 24);
  await sweep(t);

  expect(deleteUser.mock.calls).toEqual([[LEAVING]]);
  expect(await t.run(async (ctx) => ctx.db.get(leaving.userId))).toBe(null);
});

async function addMember(
  t: TestConvex<typeof schema>,
  orgId: Id<"orgs">,
  authId: string,
): Promise<void> {
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      authId: authId,
      email: `${authId}@example.com`,
      name: authId,
      plan: "free",
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "admin",
      createdAt: Date.now(),
    });
  });
}

async function requestDeletion(
  t: TestConvex<typeof schema>,
  authIds: string[],
): Promise<void> {
  for (const authId of authIds) {
    caller.authId = authId;
    await t.mutation(api.user.requestAccountDeletion, {});
  }
}

async function seedSoleOwner(
  t: TestConvex<typeof schema>,
  authId: string,
): Promise<{ userId: Id<"users">; orgId: Id<"orgs"> }> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      authId: authId,
      email: `${authId}@example.com`,
      name: authId,
      plan: "free",
    });
    const orgId = await ctx.db.insert("orgs", {
      name: authId,
      slug: authId,
      ownerAuthId: authId,
      plan: "free",
      createdAt: Date.now(),
    });
    await ctx.db.insert("orgMembers", {
      orgId: orgId,
      userId: userId,
      role: "owner",
      createdAt: Date.now(),
    });

    return { userId: userId, orgId: orgId };
  });
}

async function sweep(t: TestConvex<typeof schema>): Promise<void> {
  await t.mutation(internal.org.workosUserDeletion.sweep, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}
