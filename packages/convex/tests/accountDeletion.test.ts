/// <reference types="vite/client" />
import workosTest from "@convex-dev/workos-authkit/test";
import { createFunctionHandle } from "convex/server";
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, components, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
// The package exports no schema or test helper, so register its built schema from disk.
import stripeSchema from "../node_modules/@convex-dev/stripe/dist/component/schema.js";
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
const stripeModules = import.meta.glob(
  "../node_modules/@convex-dev/stripe/dist/component/**/*.js",
);

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

test("billing is cancelled once the identity is gone, even while core cleanup keeps failing", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  t.registerComponent("stripe", stripeSchema, stripeModules);
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  vi.stubEnv("ADMIN_ACCOUNT_SECRET", "");
  const leaving = await seedSoleOwner(t, LEAVING);
  await requestDeletion(t, [LEAVING]);

  vi.advanceTimersByTime(8 * DAY_MS);
  await t.mutation(internal.org.workosUserDeletion.sweep, {});
  for (let step = 0; step < 4; step += 1) {
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
  }

  expect(deleteUser.mock.calls).toEqual([[LEAVING]]);
  expect(await t.run(async (ctx) => ctx.db.get(leaving.userId))).not.toBe(null);
  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(
    scheduled
      .filter(({ name }) => name === "stripe:cancelUserSubscriptionsInternal")
      .map(({ state }) => state.kind),
  ).toEqual(["success"]);
});

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
