/**
 * Public project queries and mutations scoped to the authenticated user.
 */

import type { GenericMutationCtx, GenericQueryCtx } from "convex/server";
import { v } from "convex/values";
import type { DataModel } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { authKit } from "./auth";
import { uniqueProjectSlug } from "./lib/slug";
import { deleteEnvironmentContents } from "./environment";
import { getActiveOrgForUser } from "./model/ownership/org";
import { getOwnedProject, getProjectForRole } from "./model/ownership/project";
import { projectsFields } from "./schema";

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>;

const RANDOM_ADJECTIVES = [
    "amber", "azure", "brave", "calm", "cedar", "coral", "crisp", "dusk",
    "ember", "fern", "fleet", "frosted", "golden", "grand", "hazy", "hollow",
    "indigo", "jade", "keen", "lofty", "lunar", "mellow", "misty", "navy",
    "noble", "ochre", "onyx", "pale", "quiet", "rapid", "raven", "rugged",
    "rustic", "sage", "silver", "slate", "solar", "still", "swift", "teal",
    "vast", "velvet", "vivid", "warm", "wild", "winter", "wooden", "zenith",
];
const RANDOM_NOUNS = [
    "arc", "bay", "bloom", "bolt", "brook", "cave", "cliff", "cloud",
    "comet", "cove", "creek", "dawn", "delta", "dune", "dusk", "echo",
    "field", "fjord", "flame", "flare", "forge", "frost", "gale", "glen",
    "grove", "haven", "hill", "isle", "knoll", "lagoon", "lake", "leaf",
    "mesa", "moon", "moss", "peak", "pine", "ridge", "rift", "river",
    "shore", "sky", "slate", "snow", "star", "stone", "tide", "trail",
    "vale", "vault", "wave", "wind", "wood", "yard", "zephyr", "zone",
];

/** Generate a random adjective-noun project name, e.g. "amber-cove". */
function randomProjectName(): string {
    const adj = RANDOM_ADJECTIVES[Math.floor(Math.random() * RANDOM_ADJECTIVES.length)];
    const noun = RANDOM_NOUNS[Math.floor(Math.random() * RANDOM_NOUNS.length)];
    return `${adj}-${noun}`;
}

const projectDoc = v.object({
    ...projectsFields,
    _id: v.id("projects"),
    _creationTime: v.number(),
});

async function requireAuth(ctx: Ctx) {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");
    return authUser;
}

/**
 * Resolve the caller's active org id, used to scope new and listed projects.
 * Returns null when the user has no membership yet (legacy / first-load flow).
 */
async function getCallerActiveOrgId(ctx: Ctx, authId: string) {
    const user = await ctx.db
        .query("users")
        .withIndex("by_authId", (q) => q.eq("authId", authId))
        .unique();
    if (!user) return null;

    const org = await getActiveOrgForUser(ctx, user._id);

    return org?._id ?? null;
}

/**
 * Lists every project visible to the caller in their active org. Legacy
 * projects without an orgId fall back to authId ownership for backwards compat.
 */
async function listProjects(ctx: Ctx, authId: string) {
    const orgId = await getCallerActiveOrgId(ctx, authId);
    const ownedByAuth = await ctx.db
        .query("projects")
        .withIndex("by_authId", (q) => q.eq("authId", authId))
        .collect();

    const orgProjects = orgId
        ? await ctx.db
            .query("projects")
            .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
            .collect()
        : [];

    const merged = new Map<string, (typeof ownedByAuth)[number]>();
    for (const p of orgProjects) merged.set(p._id, p);
    for (const p of ownedByAuth) {
        if (!p.orgId) merged.set(p._id, p);
    }

    return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Returns the caller's most recent project. On the very first call for an
 * org that has never had a project, creates a random one plus a default
 * Production environment and marks the org as onboarded. On subsequent calls
 * where the user has deleted every project, returns null so the UI can fall
 * back to the project gallery.
 * @returns The existing or newly created project id, or null when the org has
 * been onboarded but currently has no projects.
 */
export const getOrCreateDefault = mutation({
    args: {},
    returns: v.union(v.id("projects"), v.null()),
    handler: async (ctx) => {
        const authUser = await requireAuth(ctx);

        const existing = (await listProjects(ctx, authUser.id))[0];
        const orgId = await getCallerActiveOrgId(ctx, authUser.id);

        if (existing) {
            // Lazy-backfill the flag for legacy orgs whose projects predate it,
            // so the first-time path doesn't silently re-trigger.
            if (orgId) {
                const org = await ctx.db.get(orgId);
                if (org && !org.onboardedAt) {
                    await ctx.db.patch(orgId, { onboardedAt: Date.now() });
                }
            }
            return existing._id;
        }

        if (orgId) {
            const org = await ctx.db.get(orgId);
            if (org?.onboardedAt) {
                return null;
            }
        }

        const now = Date.now();
        const name = randomProjectName();
        const projectId = await ctx.db.insert("projects", {
            authId: authUser.id,
            orgId: orgId ?? undefined,
            name: name,
            description: undefined,
            slug: await uniqueProjectSlug(ctx, authUser.id, name),
            updatedAt: now,
        });

        await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: "Development",
            kind: "development",
            isDefault: true,
            updatedAt: now,
        });

        if (orgId) {
            await ctx.db.patch(orgId, { onboardedAt: now });
        }

        return projectId;
    },
});

export const list = query({
    args: {},
    returns: v.array(projectDoc),
    handler: async (ctx) => {
        const authUser = await requireAuth(ctx);
        return listProjects(ctx, authUser.id);
    },
});

export const listWithPreview = query({
    args: {},
    returns: v.array(v.object({
        _id: v.id("projects"),
        name: v.string(),
        canvas: v.null(),
        deployedAgentCount: v.number(),
    })),
    handler: async (ctx) => {
        const authUser = await requireAuth(ctx);
        const projects = await listProjects(ctx, authUser.id);
        return projects.map((p) => ({
            _id: p._id,
            name: p.name,
            canvas: null,
            deployedAgentCount: 0,
        }));
    },
});

export const getById = query({
    args: { projectId: v.id("projects") },
    returns: v.union(v.null(), projectDoc),
    handler: async (ctx, { projectId }) => {
        const authUser = await requireAuth(ctx);
        return getOwnedProject(ctx, authUser.id, projectId);
    },
});

/**
 * Resolves a CLI-style project name/slug (and optional environment name) to the
 * caller's real project and environment ids, so a `filthy-panty` deep link can
 * land directly on that project's architecture view.
 * @param project name or slug as printed by the CLI
 * @param environment optional environment name (e.g. "development"); matched case-insensitively
 * @returns the matching ids, or null when the project is not visible to the caller
 */
export const resolveTarget = query({
    args: { project: v.string(), environment: v.optional(v.string()) },
    returns: v.union(v.null(), v.object({
        projectId: v.id("projects"),
        environmentId: v.union(v.null(), v.id("environments")),
    })),
    handler: async (ctx, { project, environment }) => {
        const authUser = await requireAuth(ctx);
        const needle = project.trim().toLowerCase();
        const match = (await listProjects(ctx, authUser.id)).find((entry) =>
            entry.name.toLowerCase() === needle || entry.slug.toLowerCase() === needle,
        );
        if (!match) return null;

        const environments = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", match._id))
            .collect();
        const wanted = environment?.trim().toLowerCase();
        const target =
            (wanted ? environments.find((entry) => entry.name.toLowerCase() === wanted) : undefined) ??
            environments.find((entry) => entry.isDefault) ??
            null;

        return { projectId: match._id, environmentId: target?._id ?? null };
    },
});

export const create = mutation({
    args: {
        name: v.string(),
        description: v.optional(v.string()),
    },
    returns: v.id("projects"),
    handler: async (ctx, { name, description }) => {
        const authUser = await requireAuth(ctx);

        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project name is required.");

        const now = Date.now();
        const orgId = await getCallerActiveOrgId(ctx, authUser.id);
        const projectId = await ctx.db.insert("projects", {
            authId: authUser.id,
            orgId: orgId ?? undefined,
            name: trimmedName,
            description: description?.trim() || undefined,
            slug: await uniqueProjectSlug(ctx, authUser.id, trimmedName),
            updatedAt: now,
        });

        await ctx.db.insert("environments", {
            authId: authUser.id,
            projectId,
            name: "Development",
            kind: "development",
            isDefault: true,
            updatedAt: now,
        });

        return projectId;
    },
});

export const update = mutation({
    args: {
        projectId: v.id("projects"),
        name: v.string(),
        description: v.optional(v.string()),
    },
    returns: v.id("projects"),
    handler: async (ctx, { projectId, name, description }) => {
        const authUser = await requireAuth(ctx);

        const project = await getProjectForRole(ctx, authUser.id, projectId, "admin");
        if (!project) throw new Error("Project not found.");

        const trimmedName = name.trim();
        if (!trimmedName) throw new Error("Project name is required.");

        const slug =
            trimmedName === project.name
                ? project.slug
                : await uniqueProjectSlug(ctx, authUser.id, trimmedName);

        await ctx.db.patch(projectId, {
            name: trimmedName,
            description: description?.trim() || undefined,
            slug,
            updatedAt: Date.now(),
        });

        return projectId;
    },
});

export const remove = mutation({
    args: { projectId: v.id("projects") },
    returns: v.id("projects"),
    handler: async (ctx, { projectId }) => {
        const authUser = await requireAuth(ctx);

        const project = await getProjectForRole(ctx, authUser.id, projectId, "admin");
        if (!project) throw new Error("Project not found.");

        const environments = await ctx.db
            .query("environments")
            .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
            .collect();

        for (const env of environments) {
            await deleteEnvironmentContents(ctx, env);
            await ctx.db.delete(env._id);
        }

        const workspaceFiles = await ctx.db
            .query("workspaceFiles")
            .withIndex("by_projectId_and_nodeId", (q) => q.eq("projectId", projectId))
            .collect();
        for (const file of workspaceFiles) {
            if (file.storageId) {
                await ctx.storage.delete(file.storageId);
            }
            await ctx.db.delete(file._id);
        }

        await ctx.db.delete(projectId);

        return projectId;
    },
});
