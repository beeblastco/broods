/**
 * Public project queries and mutations scoped to the authenticated user.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import { uniqueProjectSlug } from "./lib/slug";
import { purgeProject } from "./model/cascade";
import { getActiveOrgForUser } from "./model/ownership/org";
import { getProjectForRole } from "./model/ownership/project";
import { projectsFields } from "./schema";

const RANDOM_ADJECTIVES = [
  "amber",
  "azure",
  "brave",
  "calm",
  "cedar",
  "coral",
  "crisp",
  "dusk",
  "ember",
  "fern",
  "fleet",
  "frosted",
  "golden",
  "grand",
  "hazy",
  "hollow",
  "indigo",
  "jade",
  "keen",
  "lofty",
  "lunar",
  "mellow",
  "misty",
  "navy",
  "noble",
  "ochre",
  "onyx",
  "pale",
  "quiet",
  "rapid",
  "raven",
  "rugged",
  "rustic",
  "sage",
  "silver",
  "slate",
  "solar",
  "still",
  "swift",
  "teal",
  "vast",
  "velvet",
  "vivid",
  "warm",
  "wild",
  "winter",
  "wooden",
  "zenith",
];
const RANDOM_NOUNS = [
  "arc",
  "bay",
  "bloom",
  "bolt",
  "brook",
  "cave",
  "cliff",
  "cloud",
  "comet",
  "cove",
  "creek",
  "dawn",
  "delta",
  "dune",
  "dusk",
  "echo",
  "field",
  "fjord",
  "flame",
  "flare",
  "forge",
  "frost",
  "gale",
  "glen",
  "grove",
  "haven",
  "hill",
  "isle",
  "knoll",
  "lagoon",
  "lake",
  "leaf",
  "mesa",
  "moon",
  "moss",
  "peak",
  "pine",
  "ridge",
  "rift",
  "river",
  "shore",
  "sky",
  "slate",
  "snow",
  "star",
  "stone",
  "tide",
  "trail",
  "vale",
  "vault",
  "wave",
  "wind",
  "wood",
  "yard",
  "zephyr",
  "zone",
];

const projectDoc = v.object({
  ...projectsFields,
  _id: v.id("projects"),
  _creationTime: v.number(),
});

type Ctx = QueryCtx | MutationCtx;

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
      slug: await uniqueProjectSlug(
        ctx,
        { authId: authUser.id, orgId: orgId ?? undefined },
        trimmedName,
      ),
      updatedAt: now,
    });

    await ctx.db.insert("stages", {
      authId: authUser.id,
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });

    return projectId;
  },
});

export const getById = query({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), projectDoc),
  handler: async (ctx, { projectId }) => {
    const authUser = await requireAuth(ctx);

    return getProjectForRole(ctx, authUser.id, projectId);
  },
});

/**
 * Returns the caller's most recent project. On the very first call for an
 * org that has never had a project, creates a random one plus a default
 * Production stage and marks the org as onboarded. On subsequent calls
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
      slug: await uniqueProjectSlug(
        ctx,
        { authId: authUser.id, orgId: orgId ?? undefined },
        name,
      ),
      updatedAt: now,
    });

    await ctx.db.insert("stages", {
      authId: authUser.id,
      projectId: projectId,
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

/**
 * Lists the caller's projects. Soft-auth: returns [] (instead of throwing) when
 * no auth user is resolved yet, so the first-login WorkOS-webhook gap renders an
 * empty list rather than tripping the dashboard's React error boundary.
 */
export const list = query({
  args: {},
  returns: v.array(projectDoc),
  handler: async (ctx) => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return [];

    return listProjects(ctx, authUser.id);
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  returns: v.id("projects"),
  handler: async (ctx, { projectId }) => {
    const authUser = await requireAuth(ctx);

    const project = await getProjectForRole(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) throw new Error("Project not found.");

    await purgeProject(ctx, projectId);

    return projectId;
  },
});

/**
 * Resolves a CLI-style project name/slug (and optional stage name) to the
 * caller's real project and stage ids, so a `broods` deep link can
 * land directly on that project's architecture view.
 * @param project name or slug as printed by the CLI
 * @param stage optional stage name (e.g. "development"); matched case-insensitively
 * @returns the matching ids, or null when the project is not visible to the caller
 */
export const resolveTarget = query({
  args: { project: v.string(), stage: v.optional(v.string()) },
  returns: v.union(
    v.null(),
    v.object({
      projectId: v.id("projects"),
      stageId: v.union(v.null(), v.id("stages")),
    }),
  ),
  handler: async (ctx, { project, stage }) => {
    const authUser = await requireAuth(ctx);
    const needle = project.trim().toLowerCase();
    const match = (await listProjects(ctx, authUser.id)).find(
      (entry) =>
        entry.name.toLowerCase() === needle ||
        entry.slug.toLowerCase() === needle,
    );
    if (!match) return null;

    const stages = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", match._id))
      .collect();
    const wanted = stage?.trim().toLowerCase();
    const target =
      (wanted
        ? stages.find((entry) => entry.name.toLowerCase() === wanted)
        : undefined) ??
      stages.find((entry) => entry.isDefault) ??
      null;

    return { projectId: match._id, stageId: target?._id ?? null };
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

    const project = await getProjectForRole(
      ctx,
      authUser.id,
      projectId,
      "admin",
    );
    if (!project) throw new Error("Project not found.");

    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Project name is required.");

    // The project's own org, not the caller's active one: an admin renaming
    // from elsewhere must not re-namespace it.
    const slug =
      trimmedName === project.name
        ? project.slug
        : await uniqueProjectSlug(
            ctx,
            { authId: project.authId, orgId: project.orgId },
            trimmedName,
          );

    await ctx.db.patch(projectId, {
      name: trimmedName,
      description: description?.trim() || undefined,
      slug: slug,
      updatedAt: Date.now(),
    });

    return projectId;
  },
});

/**
 * Resolve the caller's active org id, used to scope new and listed projects.
 * Returns null when the user has no membership yet (legacy / first-load flow).
 */
async function getCallerActiveOrgId(
  ctx: Ctx,
  authId: string,
): Promise<Id<"orgs"> | null> {
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
  if (!user) return null;

  const org = await getActiveOrgForUser(ctx, user._id);

  return org?._id ?? null;
}

/**
 * Lists the projects visible to the caller, scoped to their active org. When
 * the caller has no active org (legacy / first-load), falls back to their
 * orgId-less projects owned by authId so older accounts keep working.
 */
async function listProjects(
  ctx: Ctx,
  authId: string,
): Promise<Doc<"projects">[]> {
  const orgId = await getCallerActiveOrgId(ctx, authId);

  // No active org: surface only the caller's legacy, orgId-less projects.
  if (orgId === null) {
    const ownedByAuth = await ctx.db
      .query("projects")
      .withIndex("by_authId", (q) => q.eq("authId", authId))
      .collect();

    return ownedByAuth
      .filter((p) => !p.orgId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Active org set: return only that org's projects, never another org's
  // or another caller's orgId-less projects.
  const orgProjects = await ctx.db
    .query("projects")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();

  return orgProjects.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Generate a random adjective-noun project name, e.g. "amber-cove". */
function randomProjectName(): string {
  const adj =
    RANDOM_ADJECTIVES[Math.floor(Math.random() * RANDOM_ADJECTIVES.length)];
  const noun = RANDOM_NOUNS[Math.floor(Math.random() * RANDOM_NOUNS.length)];

  return `${adj}-${noun}`;
}

async function requireAuth(
  ctx: Ctx,
): Promise<NonNullable<Awaited<ReturnType<typeof authKit.getAuthUser>>>> {
  const authUser = await authKit.getAuthUser(ctx);
  if (!authUser) throw new Error("User not found or not authenticated");

  return authUser;
}
