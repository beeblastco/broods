/**
 * GitHub repo links for the dashboard. An org admin connects the Broods
 * GitHub App once; a project then imports a repo (Broods finds its
 * `broods/`) or creates one, and Broods commits a workflow plus one project
 * key per stage as repo secrets. A push to the production or development
 * branch then deploys that stage from the user's own Actions, and the
 * `workflow_run` webhook brings the result back to the dashboard.
 */

import { type Infer, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  httpAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authKit } from "./auth";
import { insertDeployKey } from "./deployKeys";
import { requireDashboardPermission } from "./model/access";
import { randomToken } from "./model/accountSecrets";
import { ensureStage } from "./model/cliSync";
import { ClientError } from "./model/clientError";
import {
  WORKFLOW_PATH,
  authorizeUrl,
  branchExists,
  commitWorkflow,
  createRepo as createGitHubRepo,
  deployWorkflow,
  exchangeUserCode,
  findBroodsRoots,
  getRepo,
  githubApp,
  githubRequest,
  installUrl,
  installationToken,
  listInstallationRepos,
  listUserInstallations,
  requireGitHubApp,
  sealDeployKeys,
  starterFiles,
  verifyWebhookSignature,
  type GitHubApp,
  type GitHubRepo,
} from "./model/github";
import {
  getActiveOrgForUser,
  getOrgMembership,
  orgRoleMeets,
  userByAuthId,
} from "./model/ownership/org";
import { getProjectForWrite } from "./model/ownership/project";
import { projectRepoValidator } from "./schema";

const SIGN_IN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEVELOPMENT_BRANCH = "dev";

const installationValidator = v.object({
  installationId: v.number(),
  login: v.string(),
  accountType: v.union(v.literal("User"), v.literal("Organization")),
});

const repoValidator = v.object({
  installationId: v.number(),
  repoId: v.number(),
  fullName: v.string(),
  private: v.boolean(),
  defaultBranch: v.string(),
});

const rootValidator = v.object({
  rootDirectory: v.string(),
  installDirectory: v.string(),
  manager: v.union(
    v.literal("bun"),
    v.literal("npm"),
    v.literal("pnpm"),
    v.literal("yarn"),
  ),
});

const deployValidator = v.object({
  branch: v.string(),
  sha: v.string(),
  status: v.string(),
  conclusion: v.optional(v.string()),
  url: v.string(),
  updatedAt: v.number(),
});

const statusValidator = v.object({
  /** False when this deployment has no GitHub App; the dashboard hides GitHub. */
  configured: v.boolean(),
  /** Whether the caller may connect GitHub accounts: an org admin. */
  canConnect: v.boolean(),
  installations: v.array(installationValidator),
  repo: v.optional(projectRepoValidator),
  deploys: v.array(deployValidator),
});

const linkTargetValidator = v.object({
  installationId: v.number(),
  repoId: v.number(),
  rootDirectory: v.string(),
  /** The Broods API the workflow deploys to: the dashboard's own gateway. */
  baseUrl: v.string(),
  /** The branch Development deploys from; `dev` when unset, created when missing. */
  developmentBranch: v.optional(v.string()),
});

type LinkTarget = Infer<typeof linkTargetValidator>;

type ProjectRepo = NonNullable<Doc<"projects">["repo"]>;

/** The keys a link deploys with, minted before GitHub hears of them. */
interface LinkKeys {
  projectSlug: string;
  keyIds: Id<"deployKeys">[];
  production: string;
  development: string;
}

interface WorkflowRunEvent {
  action: string;
  repository: { id: number };
  workflow_run: {
    id: number;
    path: string;
    head_branch: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    html_url: string;
  };
}

interface InstallationEvent {
  action: string;
  installation: { id: number };
  repositories_removed?: Array<{ id: number }>;
}

interface RepositoryEvent {
  action: string;
  repository: { id: number; full_name: string };
}

/** What the dashboard shows: the org's GitHub accounts, and the project's link and latest deploys. */
export const status = query({
  args: { projectId: v.optional(v.id("projects")) },
  returns: statusValidator,
  handler: async (
    ctx,
    { projectId },
  ): Promise<Infer<typeof statusValidator>> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const member = await userByAuthId(ctx, user.id);
    const org = member ? await getActiveOrgForUser(ctx, member._id) : null;
    const empty = {
      configured: githubApp() !== null,
      canConnect: false,
      installations: [],
      deploys: [],
    };
    if (!member || !org) return empty;
    const membership = await getOrgMembership(ctx, org._id, member._id);
    const project = projectId ? await ctx.db.get(projectId) : null;
    const linked = project?.orgId === org._id ? project : null;
    const deploys = linked
      ? await ctx.db
          .query("githubDeploys")
          .withIndex("by_projectId_and_branch", (q) =>
            q.eq("projectId", linked._id),
          )
          .collect()
      : [];

    return {
      ...empty,
      canConnect:
        org.ownerAuthId === user.id ||
        Boolean(membership && orgRoleMeets(membership.role, "admin")),
      installations: (await orgInstallations(ctx, org._id)).map(toInstallation),
      repo: linked?.repo,
      deploys: deploys.map((deploy) => ({
        branch: deploy.branch,
        sha: deploy.sha,
        status: deploy.status,
        conclusion: deploy.conclusion,
        url: deploy.url,
        updatedAt: deploy.updatedAt,
      })),
    };
  },
});

/**
 * Starts a round trip through GitHub and answers the page to open. Without
 * `createRepo` it installs the App on another account (org admins only);
 * with it, the user signs in so Broods can create the repo as them.
 */
export const begin = mutation({
  args: {
    /** The dashboard path the callback returns to. */
    returnTo: v.optional(v.string()),
    createRepo: v.optional(
      v.object({
        projectId: v.id("projects"),
        owner: v.string(),
        name: v.string(),
        private: v.boolean(),
        baseUrl: v.string(),
      }),
    ),
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { createRepo, returnTo }): Promise<{ url: string }> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const app = requireGitHubApp();
    const orgId = createRepo
      ? (await requireLinkAccess(ctx, user.id, createRepo.projectId)).orgId
      : await requireOrgAdmin(ctx, user.id);
    if (createRepo && !/^[A-Za-z0-9._-]{1,100}$/.test(createRepo.name)) {
      throw new ClientError(
        "Repo names use letters, digits, '.', '-' and '_'.",
      );
    }
    const now = Date.now();
    const expired = await ctx.db
      .query("githubSignIns")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(20);
    for (const row of expired) await ctx.db.delete(row._id);
    const state = randomToken("gh_");
    await ctx.db.insert("githubSignIns", {
      state: state,
      authId: user.id,
      orgId: orgId,
      createRepo: createRepo,
      // Only a path on the dashboard itself, never another origin.
      returnTo:
        returnTo?.startsWith("/") && !returnTo.startsWith("//")
          ? returnTo
          : undefined,
      expiresAt: now + SIGN_IN_TTL_MS,
    });

    return {
      url: createRepo ? authorizeUrl(app, state) : installUrl(app, state),
    };
  },
});

/**
 * Lands GitHub's redirect: trades the code for the user's token, keeps the
 * installations that user can reach, and creates and links the repo when the
 * round trip asked for one. The token is dropped when this returns.
 */
export const finish = action({
  args: {
    state: v.string(),
    code: v.string(),
    installationId: v.optional(v.number()),
  },
  returns: v.object({
    projectId: v.optional(v.id("projects")),
    returnTo: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{ projectId?: Id<"projects">; returnTo?: string }> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const app = requireGitHubApp();
    const signIn = await ctx.runMutation(internal.github.takeSignIn, {
      state: args.state,
      authId: user.id,
    });
    const userToken = await exchangeUserCode(app, args.code);
    const installations = await listUserInstallations(app, userToken);
    if (
      args.installationId !== undefined &&
      !installations.some((i) => i.installationId === args.installationId)
    ) {
      throw new ClientError("That GitHub installation is not yours.");
    }
    await ctx.runMutation(internal.github.storeInstallations, {
      orgId: signIn.orgId,
      installations: installations,
    });
    const request = signIn.createRepo;
    if (!request) return { returnTo: signIn.returnTo };

    const installation = installations.find(
      (entry) => entry.login.toLowerCase() === request.owner.toLowerCase(),
    );
    if (!installation) {
      throw new ClientError(
        `Install the Broods GitHub App on ${request.owner} first.`,
      );
    }
    const keys = await ctx.runMutation(internal.github.mintLinkKeys, {
      authId: user.id,
      projectId: request.projectId,
    });
    let environments = false;
    const repo = await withKeys(ctx, keys, (): Promise<GitHubRepo> =>
      createGitHubRepo(
        app,
        userToken,
        installation,
        { name: request.name, private: request.private },
        async (created: GitHubRepo): Promise<Record<string, string>> => {
          environments = await setDeploySecrets(
            app,
            created,
            DEFAULT_DEVELOPMENT_BRANCH,
            keys,
          );

          return {
            ...starterFiles(keys.projectSlug),
            [WORKFLOW_PATH]: deployWorkflow({
              projectSlug: keys.projectSlug,
              baseUrl: request.baseUrl,
              rootDirectory: "",
              installDirectory: "",
              manager: "npm",
              productionBranch: created.defaultBranch,
              developmentBranch: DEFAULT_DEVELOPMENT_BRANCH,
              environments: environments,
            }),
          };
        },
        DEFAULT_DEVELOPMENT_BRANCH,
      ),
    );
    await ctx.runMutation(internal.github.saveLink, {
      authId: user.id,
      projectId: request.projectId,
      repo: {
        installationId: repo.installationId,
        repoId: repo.repoId,
        fullName: repo.fullName,
        rootDirectory: "",
        productionBranch: repo.defaultBranch,
        developmentBranch: DEFAULT_DEVELOPMENT_BRANCH,
        deployKeyIds: keys.keyIds,
        protectedSecrets: environments,
      },
    });

    return { projectId: request.projectId, returnTo: signIn.returnTo };
  },
});

/** Every repo the org's GitHub installations reach, for the import list. */
export const listRepos = action({
  /** Absent while the project is still being created; then an org admin may list. */
  args: { projectId: v.optional(v.id("projects")) },
  returns: v.array(repoValidator),
  handler: async (ctx, { projectId }): Promise<GitHubRepo[]> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const app = requireGitHubApp();
    const installations = await ctx.runQuery(internal.github.linkAccess, {
      authId: user.id,
      projectId: projectId,
    });
    const lists = await Promise.all(
      installations.map((installation) =>
        listInstallationRepos(app, installation.installationId),
      ),
    );

    return lists.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
  },
});

/** Where `broods/` sits in one repo, so the import can preselect it. */
export const inspectRepo = action({
  args: {
    projectId: v.optional(v.id("projects")),
    installationId: v.number(),
    repoId: v.number(),
  },
  returns: v.object({ repo: repoValidator, roots: v.array(rootValidator) }),
  handler: async (
    ctx,
    args,
  ): Promise<{ repo: GitHubRepo; roots: Infer<typeof rootValidator>[] }> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const app = requireGitHubApp();
    await requireInstallation(
      ctx,
      user.id,
      args.projectId,
      args.installationId,
    );
    const token = await installationToken(app, args.installationId);
    const repo = await getRepo(app, token, args.installationId, args.repoId);

    return {
      repo: repo,
      roots: await findBroodsRoots(
        app,
        token,
        repo.fullName,
        repo.defaultBranch,
      ),
    };
  },
});

/**
 * Links an existing repo: mints a project key per stage, seals them into
 * repo secrets, and commits the workflow to both branches (through a PR when
 * a branch is protected). A relink replaces the old keys.
 */
export const linkRepo = action({
  args: { projectId: v.id("projects"), target: linkTargetValidator },
  returns: projectRepoValidator,
  handler: async (ctx, { projectId, target }): Promise<ProjectRepo> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const app = requireGitHubApp();
    await requireInstallation(ctx, user.id, projectId, target.installationId);
    const keys = await ctx.runMutation(internal.github.mintLinkKeys, {
      authId: user.id,
      projectId: projectId,
      repoId: target.repoId,
    });
    const repo = await withKeys(ctx, keys, (): Promise<ProjectRepo> =>
      setUpRepo(app, target, keys),
    );
    await ctx.runMutation(internal.github.saveLink, {
      authId: user.id,
      projectId: projectId,
      repo: repo,
    });

    return repo;
  },
});

/** Drops the link and revokes its keys. The repo and its workflow stay as they are. */
export const unlinkRepo = mutation({
  args: { projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { projectId }): Promise<null> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    const project = await requireLinkAccess(ctx, user.id, projectId);
    await clearLink(ctx, project);

    return null;
  },
});

/** GitHub's webhook: deploy results, uninstalls, removed and renamed repos. */
export const webhook = httpAction(async (ctx, request): Promise<Response> => {
  const app = githubApp();
  if (!app) return new Response("GitHub is not configured", { status: 404 });
  const body = await request.text();
  const signed = await verifyWebhookSignature(
    app.webhookSecret,
    body,
    request.headers.get("x-hub-signature-256"),
  );
  if (!signed) return new Response("Bad signature", { status: 401 });

  const event = request.headers.get("x-github-event");
  if (event === "workflow_run") {
    const payload = JSON.parse(body) as WorkflowRunEvent;
    const run = payload.workflow_run;
    if (run.path === WORKFLOW_PATH) {
      await ctx.runMutation(internal.github.recordDeploy, {
        repoId: payload.repository.id,
        branch: run.head_branch,
        runId: run.id,
        sha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion ?? undefined,
        url: run.html_url,
      });
    }
  } else if (event === "installation") {
    const payload = JSON.parse(body) as InstallationEvent;
    if (payload.action === "deleted" || payload.action === "suspend") {
      await ctx.runMutation(internal.github.removeInstallation, {
        installationId: payload.installation.id,
      });
    }
  } else if (event === "installation_repositories") {
    const payload = JSON.parse(body) as InstallationEvent;
    const removed = (payload.repositories_removed ?? []).map((repo) => repo.id);
    if (removed.length > 0) {
      await ctx.runMutation(internal.github.unlinkRepos, { repoIds: removed });
    }
  } else if (event === "repository") {
    const payload = JSON.parse(body) as RepositoryEvent;
    if (payload.action === "deleted") {
      await ctx.runMutation(internal.github.unlinkRepos, {
        repoIds: [payload.repository.id],
      });
    } else if (
      payload.action === "renamed" ||
      payload.action === "transferred"
    ) {
      await ctx.runMutation(internal.github.renameRepo, {
        repoId: payload.repository.id,
        fullName: payload.repository.full_name,
      });
    }
  }

  return new Response(null, { status: 204 });
});

/**
 * The installations a link may use, after the caller's check: write access to
 * the project, or org admin before the project exists.
 */
export const linkAccess = internalQuery({
  args: { authId: v.string(), projectId: v.optional(v.id("projects")) },
  returns: v.array(installationValidator),
  handler: async (
    ctx,
    { authId, projectId },
  ): Promise<Infer<typeof installationValidator>[]> => {
    const orgId = projectId
      ? (await requireLinkAccess(ctx, authId, projectId)).orgId
      : await requireOrgAdmin(ctx, authId);

    return (await orgInstallations(ctx, orgId)).map(toInstallation);
  },
});

/** Removes and answers the caller's pending round trip for `state`. */
export const takeSignIn = internalMutation({
  args: { state: v.string(), authId: v.string() },
  returns: v.object({
    orgId: v.id("orgs"),
    returnTo: v.optional(v.string()),
    createRepo: v.optional(
      v.object({
        projectId: v.id("projects"),
        owner: v.string(),
        name: v.string(),
        private: v.boolean(),
        baseUrl: v.string(),
      }),
    ),
  }),
  handler: async (
    ctx,
    { state, authId },
  ): Promise<
    Pick<Doc<"githubSignIns">, "orgId" | "createRepo" | "returnTo">
  > => {
    const row = await ctx.db
      .query("githubSignIns")
      .withIndex("by_state", (q) => q.eq("state", state))
      .unique();
    if (!row || row.authId !== authId || row.expiresAt < Date.now()) {
      throw new ClientError("This GitHub sign-in expired. Start it again.");
    }
    await ctx.db.delete(row._id);

    return {
      orgId: row.orgId,
      createRepo: row.createRepo,
      returnTo: row.returnTo,
    };
  },
});

/** Upserts the installations a signed-in GitHub user reaches for the org. */
export const storeInstallations = internalMutation({
  args: { orgId: v.id("orgs"), installations: v.array(installationValidator) },
  returns: v.null(),
  handler: async (ctx, { orgId, installations }): Promise<null> => {
    const existing = await orgInstallations(ctx, orgId);
    for (const installation of installations) {
      const row = existing.find(
        (entry) => entry.installationId === installation.installationId,
      );
      const fields = {
        ...installation,
        orgId: orgId,
        updatedAt: Date.now(),
      };
      if (row) await ctx.db.patch(row._id, fields);
      else await ctx.db.insert("githubInstallations", fields);
    }

    return null;
  },
});

/** Mints a GitHub Actions key for Production and Development, creating either stage when missing. */
export const mintLinkKeys = internalMutation({
  /** `repoId`: an existing repo, refused when another project already deploys from it. */
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    repoId: v.optional(v.number()),
  },
  returns: v.object({
    projectSlug: v.string(),
    keyIds: v.array(v.id("deployKeys")),
    production: v.string(),
    development: v.string(),
  }),
  handler: async (ctx, { authId, projectId, repoId }): Promise<LinkKeys> => {
    const project = await requireLinkAccess(ctx, authId, projectId);
    if (repoId !== undefined) await requireRepoFree(ctx, repoId, projectId);
    const member = await userByAuthId(ctx, authId);
    if (!member) throw new Error("User row not found");
    const mint = async (
      stageName: string,
    ): Promise<{
      _id: Id<"deployKeys">;
      token: string;
    }> => {
      const stage = await ensureStage(ctx, project, stageName);

      return await insertDeployKey(ctx, {
        orgId: project.orgId,
        projectId: projectId,
        stageId: stage._id,
        name: "GitHub Actions",
        description: "Deploys on push from the linked GitHub repo.",
        createdBy: member._id,
      });
    };
    const production = await mint("production");
    const development = await mint("development");

    return {
      projectSlug: project.slug,
      keyIds: [production._id, development._id],
      production: production.token,
      development: development.token,
    };
  },
});

/** Deletes keys a link minted but never used, after a GitHub call failed. */
export const revokeKeys = internalMutation({
  args: { keyIds: v.array(v.id("deployKeys")) },
  returns: v.null(),
  handler: async (ctx, { keyIds }): Promise<null> => {
    for (const keyId of keyIds) {
      if (await ctx.db.get(keyId)) await ctx.db.delete(keyId);
    }

    return null;
  },
});

/** Stores the link once GitHub holds the keys, revoking the previous link's. */
export const saveLink = internalMutation({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    repo: projectRepoValidator,
  },
  returns: v.null(),
  handler: async (ctx, { authId, projectId, repo }): Promise<null> => {
    const project = await requireLinkAccess(ctx, authId, projectId);
    // Rechecked here: another link may have landed while GitHub was set up.
    await requireRepoFree(ctx, repo.repoId, projectId);
    for (const keyId of project.repo?.deployKeyIds ?? []) {
      if (repo.deployKeyIds.includes(keyId)) continue;
      if (await ctx.db.get(keyId)) await ctx.db.delete(keyId);
    }
    await ctx.db.patch(projectId, { repo: repo, updatedAt: Date.now() });

    return null;
  },
});

/** Keeps the latest workflow run per linked project and branch. */
export const recordDeploy = internalMutation({
  args: {
    repoId: v.number(),
    branch: v.string(),
    runId: v.number(),
    sha: v.string(),
    status: v.string(),
    conclusion: v.optional(v.string()),
    url: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { repoId, ...run }): Promise<null> => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_repoId", (q) => q.eq("repo.repoId", repoId))
      .collect();
    for (const project of projects) {
      const row = await ctx.db
        .query("githubDeploys")
        .withIndex("by_projectId_and_branch", (q) =>
          q.eq("projectId", project._id).eq("branch", run.branch),
        )
        .unique();
      // GitHub may deliver an older run's event after a newer one.
      if (row && row.runId > run.runId) continue;
      const fields = { ...run, projectId: project._id, updatedAt: Date.now() };
      if (row) await ctx.db.replace(row._id, fields);
      else await ctx.db.insert("githubDeploys", fields);
    }

    return null;
  },
});

/** An uninstalled App: forget the installation and unlink every repo it reached. */
export const removeInstallation = internalMutation({
  args: { installationId: v.number() },
  returns: v.null(),
  handler: async (ctx, { installationId }): Promise<null> => {
    const rows = await ctx.db
      .query("githubInstallations")
      .withIndex("by_installationId", (q) =>
        q.eq("installationId", installationId),
      )
      .collect();
    for (const row of rows) {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_orgId_and_slug", (q) => q.eq("orgId", row.orgId))
        .collect();
      for (const project of projects) {
        if (project.repo?.installationId === installationId) {
          await clearLink(ctx, project);
        }
      }
      await ctx.db.delete(row._id);
    }

    return null;
  },
});

/** Repos removed from the App or deleted: unlink the projects on them. */
export const unlinkRepos = internalMutation({
  args: { repoIds: v.array(v.number()) },
  returns: v.null(),
  handler: async (ctx, { repoIds }): Promise<null> => {
    for (const repoId of repoIds) {
      const projects = await ctx.db
        .query("projects")
        .withIndex("by_repoId", (q) => q.eq("repo.repoId", repoId))
        .collect();
      for (const project of projects) await clearLink(ctx, project);
    }

    return null;
  },
});

/** A renamed or transferred repo keeps its id; only the shown name moves. */
export const renameRepo = internalMutation({
  args: { repoId: v.number(), fullName: v.string() },
  returns: v.null(),
  handler: async (ctx, { repoId, fullName }): Promise<null> => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_repoId", (q) => q.eq("repo.repoId", repoId))
      .collect();
    for (const project of projects) {
      if (!project.repo) continue;
      await ctx.db.patch(project._id, {
        repo: { ...project.repo, fullName: fullName },
      });
    }

    return null;
  },
});

/** Removes a project's link, its keys and its deploy rows. */
async function clearLink(
  ctx: MutationCtx,
  project: Doc<"projects">,
): Promise<void> {
  for (const keyId of project.repo?.deployKeyIds ?? []) {
    if (await ctx.db.get(keyId)) await ctx.db.delete(keyId);
  }
  const deploys = await ctx.db
    .query("githubDeploys")
    .withIndex("by_projectId_and_branch", (q) => q.eq("projectId", project._id))
    .collect();
  for (const deploy of deploys) await ctx.db.delete(deploy._id);
  await ctx.db.patch(project._id, { repo: undefined, updatedAt: Date.now() });
}

async function orgInstallations(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
): Promise<Doc<"githubInstallations">[]> {
  return await ctx.db
    .query("githubInstallations")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();
}

// Throws unless `installationId` is one of the project's org's.
async function requireInstallation(
  ctx: ActionCtx,
  authId: string,
  projectId: Id<"projects"> | undefined,
  installationId: number,
): Promise<void> {
  const installations = await ctx.runQuery(internal.github.linkAccess, {
    authId: authId,
    projectId: projectId,
  });
  if (!installations.some((i) => i.installationId === installationId)) {
    throw new ClientError("Connect that GitHub account first.");
  }
}

/** The project, when the caller may write it and mint its keys (`keys:write`). */
async function requireLinkAccess(
  ctx: QueryCtx,
  authId: string,
  projectId: Id<"projects">,
): Promise<Doc<"projects">> {
  const project = await getProjectForWrite(ctx, authId, projectId);
  if (!project) throw new ClientError("Project not found.", "not_found");
  const member = await userByAuthId(ctx, authId);
  if (!member) throw new Error("User row not found");
  await requireDashboardPermission(ctx, project.orgId, member, "keys:write", {
    projectId: projectId,
  });

  return project;
}

/** The caller's active org, when they are its owner or an admin. */
async function requireOrgAdmin(
  ctx: QueryCtx,
  authId: string,
): Promise<Id<"orgs">> {
  const member = await userByAuthId(ctx, authId);
  const org = member ? await getActiveOrgForUser(ctx, member._id) : null;
  if (!member || !org) throw new ClientError("Join an organization first.");
  const membership = await getOrgMembership(ctx, org._id, member._id);
  if (
    org.ownerAuthId !== authId &&
    !(membership && orgRoleMeets(membership.role, "admin"))
  ) {
    throw new ClientError(
      "Only an org admin can connect GitHub.",
      "unauthorized",
    );
  }

  return org._id;
}

// One repo deploys one project: its workflow and secrets have room for one.
async function requireRepoFree(
  ctx: QueryCtx,
  repoId: number,
  projectId: Id<"projects">,
): Promise<void> {
  const other = await ctx.db
    .query("projects")
    .withIndex("by_repoId", (q) => q.eq("repo.repoId", repoId))
    .first();
  if (other && other._id !== projectId) {
    throw new ClientError(
      `${other.repo?.fullName ?? "That repo"} already deploys project ${other.name}. Unlink it there first.`,
    );
  }
}

// Seals both keys before any workflow can run; true when they sit in per-branch environments.
async function setDeploySecrets(
  app: GitHubApp,
  repo: GitHubRepo,
  developmentBranch: string,
  keys: LinkKeys,
): Promise<boolean> {
  return await sealDeployKeys(
    app,
    await installationToken(app, repo.installationId),
    repo.fullName,
    {
      production: { branch: repo.defaultBranch, token: keys.production },
      development: { branch: developmentBranch, token: keys.development },
    },
  );
}

// Secrets, the development branch, then the workflow on both branches.
async function setUpRepo(
  app: GitHubApp,
  target: LinkTarget,
  keys: LinkKeys,
): Promise<ProjectRepo> {
  const token = await installationToken(app, target.installationId);
  const repo = await getRepo(app, token, target.installationId, target.repoId);
  const roots = await findBroodsRoots(
    app,
    token,
    repo.fullName,
    repo.defaultBranch,
  );
  const root = roots.find(
    (entry) => entry.rootDirectory === target.rootDirectory,
  ) ?? {
    rootDirectory: target.rootDirectory,
    installDirectory: target.rootDirectory,
    manager: "npm" as const,
  };
  const developmentBranch =
    target.developmentBranch?.trim() || DEFAULT_DEVELOPMENT_BRANCH;
  const environments = await setDeploySecrets(
    app,
    repo,
    developmentBranch,
    keys,
  );
  if (
    developmentBranch !== repo.defaultBranch &&
    !(await branchExists(app, token, repo.fullName, developmentBranch))
  ) {
    const head = await githubRequest<{ object: { sha: string } }>(
      app,
      token,
      "GET",
      `/repos/${repo.fullName}/git/ref/heads/${encodeURIComponent(repo.defaultBranch)}`,
    );
    await githubRequest(
      app,
      token,
      "POST",
      `/repos/${repo.fullName}/git/refs`,
      {
        ref: `refs/heads/${developmentBranch}`,
        sha: head.object.sha,
      },
    );
  }
  const workflow = deployWorkflow({
    ...root,
    projectSlug: keys.projectSlug,
    baseUrl: target.baseUrl,
    productionBranch: repo.defaultBranch,
    developmentBranch: developmentBranch,
    environments: environments,
  });
  const productionPull = await commitWorkflow(
    app,
    token,
    repo.fullName,
    repo.defaultBranch,
    workflow,
  );
  const developmentPull =
    developmentBranch === repo.defaultBranch
      ? undefined
      : await commitWorkflow(
          app,
          token,
          repo.fullName,
          developmentBranch,
          workflow,
        );

  return {
    installationId: repo.installationId,
    repoId: repo.repoId,
    fullName: repo.fullName,
    rootDirectory: root.rootDirectory,
    productionBranch: repo.defaultBranch,
    developmentBranch: developmentBranch,
    deployKeyIds: keys.keyIds,
    protectedSecrets: environments,
    setupPullRequestUrl: productionPull ?? developmentPull,
  };
}

function toInstallation(
  row: Doc<"githubInstallations">,
): Infer<typeof installationValidator> {
  return {
    installationId: row.installationId,
    login: row.login,
    accountType: row.accountType,
  };
}

// Runs the GitHub half of a link; revokes the fresh keys when it fails.
async function withKeys<T>(
  ctx: ActionCtx,
  keys: LinkKeys,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    await ctx.runMutation(internal.github.revokeKeys, { keyIds: keys.keyIds });
    throw error;
  }
}
