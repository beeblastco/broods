/**
 * Slug helpers for project naming.
 */

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Who a project belongs to, which is also the namespace its slug is unique in. */
export interface ProjectOwner {
  authId: string;
  orgId?: Id<"orgs">;
}

export function slugifyName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug.length > 0 ? slug : "project";
}

export async function uniqueProjectSlug(
  ctx: QueryCtx,
  owner: ProjectOwner,
  baseName: string,
): Promise<string> {
  const baseSlug = slugifyName(baseName);
  let suffix = 0;

  while (true) {
    const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
    if (!(await slugTaken(ctx, owner, candidate))) return candidate;
    suffix += 1;
  }
}

// Orgs are separate namespaces, so only a sibling in the same org may force a
// suffix. Legacy rows predate org scoping and stay keyed to their owner.
async function slugTaken(
  ctx: QueryCtx,
  owner: ProjectOwner,
  slug: string,
): Promise<boolean> {
  const orgId = owner.orgId;
  if (orgId) {
    const sibling = await ctx.db
      .query("projects")
      .withIndex("by_orgId_and_slug", (q) =>
        q.eq("orgId", orgId).eq("slug", slug),
      )
      .first();

    return sibling !== null;
  }

  const owned = await ctx.db
    .query("projects")
    .withIndex("by_authId_and_slug", (q) =>
      q.eq("authId", owner.authId).eq("slug", slug),
    )
    .collect();

  return owned.some((project) => project.orgId === undefined);
}
