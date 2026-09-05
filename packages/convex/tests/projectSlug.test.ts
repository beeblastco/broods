/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import type { Id } from "../_generated/dataModel";
import { uniqueProjectSlug, type ProjectOwner } from "../lib/slug";
import schema from "../schema";

const modules = import.meta.glob("../**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

// One login can own projects in several orgs. Scoping the suffix to the login
// leaked one org's naming into another, so `client-lamy` reused in a second org
// silently became `client-lamy-1` and every slug-keyed path read the wrong name.

async function seedOrg(tt: T, slug: string): Promise<Id<"orgs">> {
  return await tt.run(
    async (ctx) =>
      await ctx.db.insert("orgs", {
        name: slug,
        slug: slug,
        ownerAuthId: "auth_owner",
        plan: "free",
        createdAt: Date.now(),
      }),
  );
}

async function seedProject(
  tt: T,
  name: string,
  owner: ProjectOwner,
): Promise<void> {
  await tt.run(async (ctx) => {
    await ctx.db.insert("projects", {
      authId: "auth_owner",
      orgId: owner.orgId,
      name: name,
      slug: name,
      updatedAt: Date.now(),
    });
  });
}

async function slugFor(
  tt: T,
  name: string,
  owner: ProjectOwner,
): Promise<string> {
  return await tt.run(async (ctx) => await uniqueProjectSlug(ctx, owner, name));
}

test("the same name in another org keeps the unsuffixed slug", async () => {
  const tt = t();
  const personal = await seedOrg(tt, "personal");
  const beeblast = await seedOrg(tt, "beeblast");
  await seedProject(tt, "client-lamy", { orgId: personal });

  const slug = await slugFor(tt, "client-lamy", { orgId: beeblast });

  expect(slug).toBe("client-lamy");
});

test("a sibling in the same org still forces a suffix", async () => {
  const tt = t();
  const beeblast = await seedOrg(tt, "beeblast");
  await seedProject(tt, "client-lamy", { orgId: beeblast });

  const slug = await slugFor(tt, "client-lamy", { orgId: beeblast });

  expect(slug).toBe("client-lamy-1");
});
