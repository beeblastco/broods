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
import { readyStageDeployment } from "./agent/deployments";
import { authKit, type AuthUser } from "./auth";
import { uniqueProjectSlug } from "./lib/slug";
import { purgeProject } from "./model/cascade";
import { getActiveOrgForUser } from "./model/ownership/org";
import { getProjectForRole } from "./model/ownership/project";
import { getOrgMembership, orgRoleMeets } from "./model/ownership/org";
import {
  getOrCreateActiveOrg,
  orgBootstrapValidator,
  type OrgBootstrap,
} from "./org/orgs";
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

type HomeTarget = OrgBootstrap & {
  projectId: Id<"projects"> | null;
  stageId: Id<"stages"> | null;
};

export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (ctx, { name, description }): Promise<Id<"projects">> => {
    const authUser = await requireAuth(ctx);

    const trimmedName = name.trim();
    if (!trimmedName) throw new Error("Project name is required.");

    const now = Date.now();
    const orgId = await getCallerActiveOrgId(ctx, authUser.id);
    if (!orgId) throw new Error("Join or create an organization first.");
    if (!(await callerCanWriteOrg(ctx, authUser.id, orgId))) {
      throw new Error("Projects can only be created by an org admin.");
    }
    const projectId = await ctx.db.insert("projects", {
      authId: authUser.id,
      orgId: orgId,
      name: trimmedName,
      description: description?.trim() || undefined,
      slug: await uniqueProjectSlug(ctx, orgId, trimmedName),
      updatedAt: now,
    });

    const stageId = await ctx.db.insert("stages", {
      authId: authUser.id,
      projectId: projectId,
      name: "Development",
      kind: "development",
      isDefault: true,
      updatedAt: now,
    });
    await readyStageDeployment(ctx, authUser, projectId, stageId);

    return projectId;
  },
});

export const getById = query({
  args: { projectId: v.id("projects") },
  returns: v.union(v.null(), projectDoc),
  handler: async (ctx, { projectId }): Promise<Doc<"projects"> | null> => {
    const authUser = await requireAuth(ctx);

    return getProjectForRole(ctx, authUser.id, projectId);
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
  handler: async (ctx): Promise<Doc<"projects">[]> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) return [];

    return listProjects(ctx, await getCallerActiveOrgId(ctx, authUser.id));
  },
});

/**
 * The dashboard home in one round trip: gets or creates the caller's active
 * org, then picks the project to open. A `broods` deep link (`project` name or
 * slug, optional `stage` name) opens that project and stage; otherwise the
 * newest project, or a random first one for an org never onboarded. Opens
 * nothing while the org still needs `org/lifecycle:provision`.
 */
export const openHome = mutation({
  args: { project: v.optional(v.string()), stage: v.optional(v.string()) },
  returns: v.object({
    ...orgBootstrapValidator.fields,
    projectId: v.union(v.null(), v.id("projects")),
    stageId: v.union(v.null(), v.id("stages")),
  }),
  handler: async (ctx, { project, stage }): Promise<HomeTarget> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const org = await getOrCreateActiveOrg(ctx, user.id);
    if (org.needsProvision) {
      return { ...org, projectId: null, stageId: null };
    }
    const projects = await listProjects(ctx, org.orgId);
    const linked = project
      ? await deepLinkTarget(ctx, projects, project, stage)
      : null;
    if (linked) return { ...org, ...linked };

    return {
      ...org,
      projectId: await defaultProjectId(ctx, user, org.orgId, projects),
      stageId: null,
    };
  },
});

export const remove = mutation({
  args: { projectId: v.id("projects") },
  returns: v.id("projects"),
  handler: async (ctx, { projectId }): Promise<Id<"projects">> => {
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

export const update = mutation({
  args: {
    projectId: v.id("projects"),
    name: v.string(),
    description: v.optional(v.string()),
  },
  returns: v.id("projects"),
  handler: async (
    ctx,
    { projectId, name, description },
  ): Promise<Id<"projects">> => {
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
        : await uniqueProjectSlug(ctx, project.orgId, trimmedName);

    await ctx.db.patch(projectId, {
      name: trimmedName,
      description: description?.trim() || undefined,
      slug: slug,
      updatedAt: Date.now(),
    });

    return projectId;
  },
});

/** Whether the caller may write in `orgId`: the org owner, or an admin member. */
async function callerCanWriteOrg(
  ctx: Ctx,
  authId: string,
  orgId: Id<"orgs">,
): Promise<boolean> {
  const org = await ctx.db.get(orgId);
  if (!org) return false;
  if (org.ownerAuthId === authId) return true;
  const user = await ctx.db
    .query("users")
    .withIndex("by_authId", (q) => q.eq("authId", authId))
    .unique();
  if (!user) return false;
  const membership = await getOrgMembership(ctx, orgId, user._id);

  return Boolean(membership && orgRoleMeets(membership.role, "admin"));
}

/**
 * The deep-linked project, matched by name or slug, and its stage by name,
 * else the default stage. Null when the caller cannot see that project.
 */
async function deepLinkTarget(
  ctx: Ctx,
  projects: Doc<"projects">[],
  project: string,
  stage: string | undefined,
): Promise<{
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
} | null> {
  const needle = project.trim().toLowerCase();
  const match = projects.find(
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
}

/**
 * The newest project. An org that never had one gets a random project with a
 * Development stage and its runtime key on an admin's first visit and is
 * marked onboarded; after that, an org with no projects opens the project
 * gallery (null).
 */
async function defaultProjectId(
  ctx: MutationCtx,
  user: AuthUser,
  orgId: Id<"orgs">,
  projects: Doc<"projects">[],
): Promise<Id<"projects"> | null> {
  const org = await ctx.db.get(orgId);
  const existing = projects[0];
  if (existing) {
    // Stamp the flag on an org whose projects predate it, so the first-time
    // path doesn't silently re-trigger.
    if (org && !org.onboardedAt) {
      await ctx.db.patch(orgId, { onboardedAt: Date.now() });
    }

    return existing._id;
  }
  if (org?.onboardedAt) return null;
  // A member never creates the first project; an admin will.
  if (!(await callerCanWriteOrg(ctx, user.id, orgId))) return null;

  const now = Date.now();
  const name = randomProjectName();
  const projectId = await ctx.db.insert("projects", {
    authId: user.id,
    orgId: orgId,
    name: name,
    description: undefined,
    slug: await uniqueProjectSlug(ctx, orgId, name),
    updatedAt: now,
  });
  const stageId = await ctx.db.insert("stages", {
    authId: user.id,
    projectId: projectId,
    name: "Development",
    kind: "development",
    isDefault: true,
    updatedAt: now,
  });
  await readyStageDeployment(ctx, user, projectId, stageId);
  await ctx.db.patch(orgId, { onboardedAt: now });

  return projectId;
}

/**
 * Resolve the caller's active org id, used to scope new and listed projects.
 * Returns null when the user has no membership yet (first-load flow).
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
 * Lists the projects visible to the caller: their active org's, newest first.
 * Nothing before the caller has joined an org (`orgId` null).
 */
async function listProjects(
  ctx: Ctx,
  orgId: Id<"orgs"> | null,
): Promise<Doc<"projects">[]> {
  if (orgId === null) return [];

  const orgProjects = await ctx.db
    .query("projects")
    .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", orgId))
    .collect();

  return orgProjects.sort((a, b) => b.updatedAt - a.updatedAt);
}

function randomProjectName(): string {
  const adj =
    RANDOM_ADJECTIVES[Math.floor(Math.random() * RANDOM_ADJECTIVES.length)];
  const noun = RANDOM_NOUNS[Math.floor(Math.random() * RANDOM_NOUNS.length)];

  return `${adj}-${noun}`;
}

async function requireAuth(ctx: Ctx): Promise<AuthUser> {
  const authUser = await authKit.getAuthUser(ctx);
  if (!authUser) throw new Error("User not found or not authenticated");

  return authUser;
}
