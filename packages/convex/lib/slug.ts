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

/** The org is the namespace a project slug is unique in. */
export async function uniqueProjectSlug(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  baseName: string,
): Promise<string> {
  const baseSlug = slugifyName(baseName);
  let suffix = 0;

  while (true) {
    const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
    if (!(await slugTaken(ctx, orgId, candidate))) return candidate;
    suffix += 1;
  }
}

// Orgs are separate namespaces, so only a sibling in the same org may force a
// suffix.
async function slugTaken(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
  slug: string,
): Promise<boolean> {
  const sibling = await ctx.db
    .query("projects")
    .withIndex("by_orgId_and_slug", (q) =>
      q.eq("orgId", orgId).eq("slug", slug),
    )
    .first();

  return sibling !== null;
}
