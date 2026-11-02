import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { ClientError } from "../model/clientError";

// An identifier, not a label: it rides the runtime URL, WebSocket paths and Loki/Tempo labels.
export const STAGE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;

export function assertStageName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ClientError("Stage name is required.");
  if (!STAGE_NAME_PATTERN.test(trimmed)) {
    throw new ClientError(
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
  orgId: Id<"orgs">,
  baseName: string,
): Promise<string> {
  const baseSlug = slugifyName(baseName);
  let suffix = 0;

  for (;;) {
    const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
    if (!(await slugTaken(ctx, orgId, candidate))) return candidate;
    suffix += 1;
  }
}

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
