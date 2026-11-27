/// <reference types="vite/client" />
import workosTest from "@convex-dev/workos-authkit/test";
import { createFunctionHandle } from "convex/server";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { components, internal } from "../_generated/api";
import schema from "../schema";

const AUTH_ID = "user_missing_from_component";
const modules = import.meta.glob("../**/*.ts");

afterEach((): void => {
  vi.unstubAllEnvs();
});

// authkit 0.3.0 forwards user.deleted with only the id, even for a user its own table never stored.
test("user.deleted for a user only in our table queues cleanup once", async (): Promise<void> => {
  const t = convexTest(schema, modules);
  workosTest.register(t);
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "deleted@example.com",
      name: "Deleted",
      plan: "free",
    }),
  );
  const onEventHandle = await t.run(
    async (): Promise<string> =>
      await createFunctionHandle(internal.auth.authKitEvent),
  );

  for (const eventId of ["event_deleted", "event_deleted_redelivered"]) {
    await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
      event: {
        id: eventId,
        createdAt: "2026-11-03T00:00:00.000Z",
        event: "user.deleted",
        data: { id: AUTH_ID },
      },
      onEventHandle: onEventHandle,
    });
  }

  const user = await t.run(async (ctx) => ctx.db.get(userId));
  expect(user?.workosDeletionRequestedAt).toEqual(expect.any(Number));
  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(
    scheduled.map(({ name, args }) => ({ name: name, args: args })),
  ).toEqual([
    {
      name: "org/workosUserDeletionCleanup:run",
      args: [{ authId: AUTH_ID }],
    },
  ]);
});

test("user.deleted on the managed service also queues the billing cancel", async (): Promise<void> => {
  vi.stubEnv("BROODS_MANAGED_SERVICE", "true");
  const t = convexTest(schema, modules);
  workosTest.register(t);
  await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId: AUTH_ID,
      email: "deleted@example.com",
      name: "Deleted",
      plan: "free",
    }),
  );
  const onEventHandle = await t.run(
    async (): Promise<string> =>
      await createFunctionHandle(internal.auth.authKitEvent),
  );

  await t.mutation(components.workOSAuthKit.lib.onWebhookEvent, {
    event: {
      id: "event_deleted",
      createdAt: "2026-11-03T00:00:00.000Z",
      event: "user.deleted",
      data: { id: AUTH_ID },
    },
    onEventHandle: onEventHandle,
  });

  const scheduled = await t.run(async (ctx) =>
    ctx.db.system.query("_scheduled_functions").collect(),
  );
  expect(scheduled.map(({ name }) => name)).toEqual([
    "stripe:cancelUserSubscriptionsInternal",
    "org/workosUserDeletionCleanup:run",
  ]);
});
