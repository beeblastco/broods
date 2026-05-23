import type { QueryCtx } from "../_generated/server";

/**
 * Converts a display name into a URL-safe slug segment.
 * @param name Raw project or environment name
 * @returns Lowercase hyphenated slug
 */
export function slugifyName(name: string): string {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);

    return slug.length > 0 ? slug : "project";
}

/**
 * Resolves a unique project slug for the authenticated user.
 * @param ctx Convex query context
 * @param authId WorkOS user id owning the project
 * @param baseName Project name used to derive the slug
 * @returns Unused slug for this user
 */
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

        if (!existing) {
            return candidate;
        }

        suffix += 1;
    }
}
