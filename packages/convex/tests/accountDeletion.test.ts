/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const DAY_MS = 24 * 60 * 60 * 1000;
const LEAVING = "auth_leaving";
const STAYING = "auth_staying";

const caller = vi.hoisted(() => ({ authId: "auth_leaving" }));
const deleteUser = vi.hoisted(() => vi.fn(async (): Promise<void> => {}));

vi.mock("../auth", () => ({
  authKit: {
    getAuthUser: async () => ({ id: caller.authId }),
    registerRoutes: () => undefined,
    workos: { userManagement: { deleteUser: deleteUser } },
  },
}));

const modules = import.meta.glob("../**/*.ts");

afterEach((): void => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  deleteUser.mockClear();
});

test("a past-due account deletion removes the user and their org, a cancelled one stays", async (): Promise<void> => {
  vi.useFakeTimers();
  vi.stubEnv("BROODS_ACCOUNT_MANAGE_URL", "https://core.test");
  vi.stubEnv("ADMIN_ACCOUNT_SECRET", "secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (): Promise<Response> => new Response(null, { status: 204 })),
  );
  const t = convexTest(schema, modules);
  const leaving = await seedSoleOwner(t, LEAVING);
  const staying = await seedSoleOwner(t, STAYING);

  for (const authId of [LEAVING, STAYING]) {
    caller.authId = authId;
    await t.mutation(api.user.requestAccountDeletion, {});
  }
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
  await t.action(internal.org.workosUserDeletionCleanup.sweep, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}
