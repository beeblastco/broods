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
const WORKOS_USER = {
  id: "auth_user",
  email: "user@example.com",
  firstName: "WorkOS",
  lastName: "Name",
};

const profileNameTest = (): TestConvex<typeof schema> =>
  convexTest(schema, modules);

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

  test("fills a name the user never edited", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "user@example.com");

    await t.mutation(api.user.syncProfile, { name: "WorkOS Name" });

    expect((await readUser(t, userId))?.name).toBe("WorkOS Name");
  });
});

describe("WorkOS user webhooks", () => {
  test("user.created for an existing row keeps a saved name", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "Chosen Name", true);

    await t.mutation(internal.auth.authKitEvent, {
      event: "user.created",
      data: WORKOS_USER,
    });

    expect((await readUser(t, userId))?.name).toBe("Chosen Name");
  });

  test("user.updated keeps a saved name", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "Chosen Name", true);

    await t.mutation(internal.auth.authKitEvent, {
      event: "user.updated",
      data: WORKOS_USER,
    });

    expect((await readUser(t, userId))?.name).toBe("Chosen Name");
  });

  test("user.updated passes on a WorkOS rename for an unedited name", async () => {
    const t = profileNameTest();
    const userId = await seedUser(t, "Old WorkOS Name");

    await t.mutation(internal.auth.authKitEvent, {
      event: "user.updated",
      data: WORKOS_USER,
    });

    expect((await readUser(t, userId))?.name).toBe("WorkOS Name");
  });
});

async function readUser(
  t: TestConvex<typeof schema>,
  userId: Id<"users">,
): Promise<Doc<"users"> | null> {
  return await t.run(async (ctx) => ctx.db.get(userId));
}

async function seedUser(
  t: TestConvex<typeof schema>,
  name: string,
  nameEdited?: boolean,
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      authId: "auth_user",
      email: "user@example.com",
      name: name,
      nameEdited: nameEdited,
      avatarUrl: "https://example.com/old.png",
      plan: "free",
    }),
  );
}
