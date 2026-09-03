/**
 * Slug helpers for project and stage naming.
 */

import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * A custom stage name is an identifier, not a label: it rides the public
 * runtime URL, the WebSocket paths and the Loki/Tempo labels as-is.
 */
export const STAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** Who a project belongs to, which is also the namespace its slug is unique in. */
export interface ProjectOwner {
  authId: string;
  orgId?: Id<"orgs">;
}

/** Trim a custom stage name and refuse anything that is not already a slug. */
export function assertStageName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Stage name is required.");
  if (!STAGE_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `Stage name must be lowercase letters, digits and dashes (try "${slugifyName(trimmed, "stage")}").`,
    );
  }

  return trimmed;
}

export function slugifyName(name: string, fallback = "project"): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return slug.length > 0 ? slug : fallback;
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
