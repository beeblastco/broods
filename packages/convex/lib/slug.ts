/**
 * Slug helpers for project naming.
 */

import type { QueryCtx } from "../_generated/server";

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
    authId: string,
    baseName: string,
): Promise<string> {
    const baseSlug = slugifyName(baseName);
    let suffix = 0;

    while (true) {
        const candidate = suffix === 0 ? baseSlug : `${baseSlug}-${suffix}`;
        const existing = await ctx.db
            .query("projects")
            .withIndex("by_authId_and_slug", (q) =>
                q.eq("authId", authId).eq("slug", candidate),
            )
            .first();

        if (!existing) return candidate;
        suffix += 1;
    }
}
