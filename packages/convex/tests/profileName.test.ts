/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

vi.mock("../auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth")>()),
  authKit: { getAuthUser: async () => ({ id: "auth_user" }) },
}));

const modules = import.meta.glob("../**/*.ts");

const profileNameTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof profileNameTest>;

describe("syncProfile", () => {
  test("keeps a name saved through Account settings", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "WorkOS Name");
    await t.mutation(api.user.updateProfile, { name: "Chosen Name" });

    await t.mutation(api.user.syncProfile, {
      name: "WorkOS Name",
      avatarUrl: "https://example.com/new.png",
    });

    const user = await readUser(t, userId);
    expect(user?.name).toBe("Chosen Name");
    expect(user?.avatarUrl).toBe("https://example.com/new.png");
  });

  test("fills the name while it is still the email fallback", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "user@example.com");

    await t.mutation(api.user.syncProfile, { name: "WorkOS Name" });

    expect((await readUser(t, userId))?.name).toBe("WorkOS Name");
  });
});

describe("user.updated webhook", () => {
  test("keeps a name saved through Account settings", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "Chosen Name");

    await t.mutation(internal.auth.authKitEvent, {
      event: "user.updated",
      data: workosUser(),
    });

    expect((await readUser(t, userId))?.name).toBe("Chosen Name");
  });

  test("replaces the email fallback with the WorkOS name", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "user@example.com");

    await t.mutation(internal.auth.authKitEvent, {
      event: "user.updated",
      data: workosUser(),
    });

    expect((await readUser(t, userId))?.name).toBe("WorkOS Name");
  });
});

async function readUser(
  t: T,
  userId: Id<"users">,
): Promise<Doc<"users"> | null> {
  return await t.run(async (ctx) => ctx.db.get(userId));
}

async function seedUser(t: T, name: string): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId: "auth_user",
      email: "user@example.com",
      name: name,
      avatarUrl: "https://example.com/old.png",
      plan: "free",
    }),
  );
}

function workosUser(): Record<string, string> {
  return {
    id: "auth_user",
    email: "user@example.com",
    firstName: "WorkOS",
    lastName: "Name",
  };
}
