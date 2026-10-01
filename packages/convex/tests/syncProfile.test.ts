/// <reference types="vite/client" />
import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";

vi.mock("../auth", () => ({
  authKit: { getAuthUser: async () => ({ id: "auth_user" }) },
}));

const modules = import.meta.glob("../**/*.ts");

const syncProfileTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

type T = ReturnType<typeof syncProfileTest>;

describe("syncProfile", () => {
  test("keeps a name saved through Account settings", async () => {
    const t = syncProfileTest();
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
    const t = syncProfileTest();
    const userId = await seedUser(t, "user@example.com");

    await t.mutation(api.user.syncProfile, { name: "WorkOS Name" });

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
