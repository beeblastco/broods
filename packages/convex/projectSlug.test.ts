/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import { uniqueProjectSlug } from "./lib/slug";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const t = () => convexTest(schema, modules);
type T = ReturnType<typeof t>;

// One login can own projects in several orgs. Scoping the suffix to the login
// leaked one org's naming into another, so `client-lamy` reused in a second org
// silently became `client-lamy-1` and every slug-keyed path read the wrong name.

async function orgId(tt: T, slug: string): Promise<Id<"orgs">> {
  return await tt.run(async (ctx) => {
    return await ctx.db.insert("orgs", {
      name: slug,
      slug: slug,
      ownerAuthId: "auth_owner",
      plan: "free" as const,
      createdAt: Date.now(),
    });
  });
}

async function seedProject(
  tt: T,
  name: string,
  owner: { authId: string; orgId?: Id<"orgs"> },
): Promise<void> {
  await tt.run(async (ctx) => {
    await ctx.db.insert("projects", {
      authId: owner.authId,
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
  owner: { authId: string; orgId?: Id<"orgs"> },
): Promise<string> {
  return await tt.run(async (ctx) => await uniqueProjectSlug(ctx, owner, name));
}

test("the same name in another org keeps the unsuffixed slug", async () => {
  const tt = t();
  const personal = await orgId(tt, "personal");
  const beeblast = await orgId(tt, "beeblast");
  await seedProject(tt, "client-lamy", {
    authId: "auth_owner",
    orgId: personal,
  });

  const slug = await slugFor(tt, "client-lamy", {
    authId: "auth_owner",
    orgId: beeblast,
  });

  expect(slug).toBe("client-lamy");
});

test("a sibling in the same org still forces a suffix", async () => {
  const tt = t();
  const beeblast = await orgId(tt, "beeblast");
  await seedProject(tt, "client-lamy", {
    authId: "auth_owner",
    orgId: beeblast,
  });

  const slug = await slugFor(tt, "client-lamy", {
    authId: "auth_member",
    orgId: beeblast,
  });

  expect(slug).toBe("client-lamy-1");
});

// Legacy rows carry no orgId, so they keep colliding per login rather than
// against every other login's orgId-less projects.
test("orgId-less projects stay scoped to their owner", async () => {
  const tt = t();
  await seedProject(tt, "client-lamy", { authId: "auth_owner" });

  expect(await slugFor(tt, "client-lamy", { authId: "auth_owner" })).toBe(
    "client-lamy-1",
  );
  expect(await slugFor(tt, "client-lamy", { authId: "auth_other" })).toBe(
    "client-lamy",
  );
});

// An org-owned project must not block a legacy row's slug, or the suffix
// creeps back in through the other direction.
test("an org project does not block an orgId-less slug", async () => {
  const tt = t();
  const beeblast = await orgId(tt, "beeblast");
  await seedProject(tt, "client-lamy", {
    authId: "auth_owner",
    orgId: beeblast,
  });

  const slug = await slugFor(tt, "client-lamy", { authId: "auth_owner" });

  expect(slug).toBe("client-lamy");
});
