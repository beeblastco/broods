/**
 * GitHub repo links. An org admin connects the Broods GitHub App once; a project imports a repo
 * (Broods finds its `broods/`) or creates one, and Broods commits a workflow plus a project key
 * per stage as repo secrets. A push to the production or development branch deploys that stage
 * from the user's own Actions; the `workflow_run` webhook brings the result to the dashboard.
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
import { cliLoginTokenHash } from "./cli/auth";
import { insertDeployKey } from "./deployKeys";
import {
  hasDashboardPermission,
  requireDashboardPermission,
} from "./model/access";
import { slugifyName } from "./lib/slug";
import { randomToken } from "./model/accountSecrets";
import { ensureStage } from "./model/cliSync";
import { deleteStageContents } from "./stage";
import { ClientError, clientErrorResponse } from "./model/clientError";
import { json, jsonError } from "./model/httpJson";
import {
  STAGES,
  GitHubApiError,
  WORKFLOW_PATH,
  administeredInstallations,
  authorizeUrl,
  commitWorkflow,
  createBranch,
  createRepo as createGitHubRepo,
  deployWorkflow,
  developmentBranchFor,
  exchangeUserCode,
  findBroodsRoots,
  getRepo,
  githubApp,
  installUrl,
  installationToken,
  listBranches,
  listInstallationRepos,
  listUserInstallations,
  requireGitHubApp,
  sealDeployKeys,
  starterFiles,
  startRepo,
  verifyWebhookSignature,
  type GitHubApp,
  type GitHubRepo,
  type Stage,
} from "./model/github";
import {
  getActiveOrgForUser,
  getOrgMembership,
  orgRoleMeets,
  userByAuthId,
} from "./model/ownership/org";
import { getProjectForWrite } from "./model/ownership/project";
import {
  githubInstallationsFields,
  githubSignInsFields,
  projectRepoValidator,
} from "./schema";

const SIGN_IN_TTL_MS = 10 * 60 * 1000;

/** How long a link in flight holds its repo before another project may take it. */
const LINK_CLAIM_TTL_MS = 10 * 60 * 1000;

const installationValidator = v.object({
  installationId: githubInstallationsFields.installationId,
  login: githubInstallationsFields.login,
  accountType: githubInstallationsFields.accountType,
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
  /**
   * Whether the caller may link or unlink this project's repo (`keys:write`), or, with no project,
   * create one (org admin).
   */
  canLink: v.boolean(),
  /** GitHub's web root for repo links; absent without an App. */
  webUrl: v.optional(v.string()),
  /** Whether the project has a Production stage, which a link deploys by default. */
  hasProduction: v.boolean(),
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
  /**
   * The branch Production deploys from, none when null. Unset: the default
   * branch when the project already has a Production stage, else none.
   */
  productionBranch: v.optional(v.union(v.string(), v.null())),
  /**
   * The branch Development deploys from, created when missing; none when
   * null. Unset: `dev` beside Production, else the default branch.
   */
  developmentBranch: v.optional(v.union(v.string(), v.null())),
});

type LinkTarget = Infer<typeof linkTargetValidator>;

type ProjectRepo = NonNullable<Doc<"projects">["repo"]>;

/** The keys a link deploys with, minted before GitHub hears of them. */
interface LinkKeys {
  projectId: Id<"projects">;
  projectSlug: string;
  keyIds: Id<"deployKeys">[];
  /** Stages the minting added, removed again if the link fails. */
  stageIds: Id<"stages">[];
  /** The branches a remapped link deployed from, whose workflow must stop deploying. */
  previousBranches: string[];
  production?: string;
  development?: string;
}

/**
 * `POST /v1/account/github/link`: a repo by `owner/name`, and where its `broods/` sits when it has
 * several.
 */
interface CliLinkRequest {
  repo?: string;
  folder?: string;
  baseUrl?: string;
  productionBranch?: string | null;
  developmentBranch?: string | null;
}

interface WorkflowRunEvent {
  action: string;
  repository: { id: number };
  workflow_run: {
    id: number;
    run_attempt?: number;
    path: string;
    head_branch: string;
    head_sha: string;
    status: string;
    conclusion: string | null;
    html_url: string;
    run_started_at?: string;
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

/** What the dashboard shows: the org's GitHub accounts, the project's link and latest deploys. */
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

    return await readStatus(ctx, user.id, projectId);
  },
});

/** `status` for a `broods login` token, in the org the token acts in. */
export const statusFor = internalQuery({
  args: {
    authId: v.string(),
    orgId: v.id("orgs"),
    projectId: v.optional(v.id("projects")),
  },
  returns: statusValidator,
  handler: async (
    ctx,
    { authId, orgId, projectId },
  ): Promise<Infer<typeof statusValidator>> =>
    await readStatus(ctx, authId, projectId, orgId),
});

// The org's GitHub accounts and the project's link, as the caller may see them.
async function readStatus(
  ctx: QueryCtx,
  authId: string,
  projectId: Id<"projects"> | undefined,
  orgId?: Id<"orgs">,
): Promise<Infer<typeof statusValidator>> {
  const member = await userByAuthId(ctx, authId);
  const org = member
    ? orgId
      ? await ctx.db.get(orgId)
      : await getActiveOrgForUser(ctx, member._id)
    : null;
  const app = githubApp();
  const empty = {
    configured: app !== null,
    canConnect: false,
    canLink: false,
    webUrl: app?.webUrl,
    hasProduction: false,
    installations: [],
    deploys: [],
  };
  if (!member || !org || !(await isOrgMember(ctx, org, member))) return empty;
  const isAdmin = await isOrgAdmin(ctx, org, member);
  const project = projectId ? await ctx.db.get(projectId) : null;
  const linked = project?.orgId === org._id ? project : null;
  const stages = linked
    ? await ctx.db
        .query("stages")
        .withIndex("by_projectId", (q) => q.eq("projectId", linked._id))
        .collect()
    : [];
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
    canConnect: isAdmin,
    hasProduction: stages.some((stage) => stage.kind === "production"),
    canLink: linked
      ? await hasDashboardPermission(ctx, org._id, member, "keys:write", {
          projectId: linked._id,
        })
      : isAdmin,
    installations: await orgInstallations(ctx, org._id),
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
}

/**
 * Starts a round trip through GitHub and answers the page to open. Without
 * `createRepo` it installs the App on another account (org admins only);
 * with it, the user signs in so Broods can create the repo as them.
 */
export const begin = mutation({
  args: {
    returnTo: githubSignInsFields.returnTo,
    createRepo: githubSignInsFields.createRepo,
  },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { createRepo, returnTo }): Promise<{ url: string }> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    return await startSignIn(ctx, user.id, createRepo, returnTo);
  },
});

/**
 * `begin` without a new repo, for a `broods login` token in its org: installs the App on another
 * account.
 */
export const beginFor = internalMutation({
  args: { authId: v.string(), orgId: v.id("orgs") },
  returns: v.object({ url: v.string() }),
  handler: async (ctx, { authId, orgId }): Promise<{ url: string }> =>
    await startSignIn(ctx, authId, undefined, undefined, orgId),
});

// Records the round trip's state and answers GitHub's page for it.
async function startSignIn(
  ctx: MutationCtx,
  authId: string,
  createRepo: Doc<"githubSignIns">["createRepo"],
  returnTo: string | undefined,
  orgIdForConnect?: Id<"orgs">,
): Promise<{ url: string }> {
  const app = requireGitHubApp();
  const orgId = createRepo
    ? (await requireLinkAccess(ctx, authId, createRepo.projectId)).orgId
    : await requireOrgAdmin(ctx, authId, orgIdForConnect);
  if (createRepo && !/^[A-Za-z0-9._-]{1,100}$/.test(createRepo.name)) {
    throw new ClientError("Repo names use letters, digits, '.', '-' and '_'.");
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
    authId: authId,
    orgId: orgId,
    createRepo: createRepo,
    returnTo: localPath(returnTo),
    expiresAt: now + SIGN_IN_TTL_MS,
  });

  return {
    url: createRepo ? authorizeUrl(app, state) : installUrl(app, state),
  };
}

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
    const request = signIn.createRepo;
    if (!request) {
      const installations = await administeredInstallations(
        app,
        userToken,
        await listUserInstallations(app, userToken),
      );
      if (
        args.installationId !== undefined &&
        !installations.some((i) => i.installationId === args.installationId)
      ) {
        throw new ClientError("You are not an admin of that GitHub account.");
      }
      await ctx.runMutation(internal.github.storeInstallations, {
        orgId: signIn.orgId,
        installations: installations,
      });

      return { returnTo: signIn.returnTo };
    }

    // A new repo goes under an account an org admin already connected.
    const installation = (
      await ctx.runQuery(internal.github.linkAccess, {
        authId: user.id,
        projectId: request.projectId,
      })
    ).find(
      (entry) => entry.login.toLowerCase() === request.owner.toLowerCase(),
    );
    if (!installation) {
      throw new ClientError(`Connect ${request.owner} to Broods first.`);
    }
    const keys = await ctx.runMutation(internal.github.mintLinkKeys, {
      authId: user.id,
      projectId: request.projectId,
    });
    await withKeys(ctx, keys, async (): Promise<void> => {
      const created = await createGitHubRepo(app, userToken, installation, {
        name: request.name,
        private: request.private,
      });
      try {
        await startRepo(
          app,
          userToken,
          created,
          starterFiles(keys.projectSlug),
        );
        await linkTarget(ctx, app, user.id, keys, {
          installationId: created.installationId,
          repoId: created.repoId,
          rootDirectory: "",
          baseUrl: request.baseUrl,
        });
      } catch (error) {
        // The repo exists now, and a retry with its name would be refused.
        const reason = error instanceof Error ? error.message : String(error);
        throw new ClientError(
          `Created ${created.fullName}, but setting it up failed (${reason}). Link it with Import repo, or delete it on GitHub and try again.`,
        );
      }
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

    return await listReposFor(ctx, user.id, projectId);
  },
});

// A CLI link: finds `owner/name` among the linkable repos and its one `broods/` (or `folder`).
async function linkByName(
  ctx: ActionCtx,
  authId: string,
  projectId: Id<"projects">,
  body: CliLinkRequest,
): Promise<ProjectRepo> {
  if (typeof body.repo !== "string" || typeof body.baseUrl !== "string") {
    throw new ClientError("repo (owner/name) and baseUrl are required.");
  }
  const name = body.repo.toLowerCase();
  const repo = (await listReposFor(ctx, authId, projectId)).find(
    (entry) => entry.fullName.toLowerCase() === name,
  );
  if (!repo) {
    throw new ClientError(
      `${body.repo} is not in a connected GitHub account. Run \`broods github connect\` first.`,
      "not_found",
    );
  }
  const { roots } = await inspectFor(ctx, authId, {
    projectId: projectId,
    installationId: repo.installationId,
    repoId: repo.repoId,
  });
  const folders = roots.map((root) => root.rootDirectory);
  if (folders.length === 0) {
    throw new ClientError(
      `${repo.fullName} has no broods/ on ${repo.defaultBranch}.`,
    );
  }
  const folder =
    body.folder === undefined
      ? folders.length === 1
        ? folders[0]
        : undefined
      : body.folder.replace(/^\/+|\/+$/g, "");
  if (folder === undefined || !folders.includes(folder)) {
    throw new ClientError(
      `Pick the folder holding broods/ with --folder: ${folders.map((entry) => entry || "/").join(", ")}.`,
    );
  }

  return await linkFor(ctx, authId, projectId, {
    installationId: repo.installationId,
    repoId: repo.repoId,
    rootDirectory: folder,
    baseUrl: body.baseUrl,
    productionBranch: body.productionBranch,
    developmentBranch: body.developmentBranch,
  });
}

// Every repo the caller's linkable installations reach, sorted by name.
async function listReposFor(
  ctx: ActionCtx,
  authId: string,
  projectId: Id<"projects"> | undefined,
): Promise<GitHubRepo[]> {
  const app = requireGitHubApp();
  const installations = await ctx.runQuery(internal.github.linkAccess, {
    authId: authId,
    projectId: projectId,
  });
  // One account GitHub no longer answers for must not empty the whole list.
  const lists = await Promise.allSettled(
    installations.map((installation) =>
      listInstallationRepos(app, installation.installationId),
    ),
  );
  const listed = lists.flatMap((list) =>
    list.status === "fulfilled" ? [list.value] : [],
  );
  const failed = lists.find((list) => list.status === "rejected");
  if (listed.length === 0 && failed) throw failed.reason;

  return listed.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** Where `broods/` sits in one repo, so the import can preselect it. */
export const inspectRepo = action({
  args: {
    projectId: v.optional(v.id("projects")),
    installationId: v.number(),
    repoId: v.number(),
  },
  returns: v.object({
    repo: repoValidator,
    roots: v.array(rootValidator),
    /** The repo's branches, the default first, for the branch pickers. */
    branches: v.array(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    repo: GitHubRepo;
    roots: Infer<typeof rootValidator>[];
    branches: string[];
  }> => {
    // Check authenticated user
    const user = await authKit.getAuthUser(ctx);
    if (!user) {
      throw new Error("User not found or not authenticated");
    }

    return await inspectFor(ctx, user.id, args);
  },
});

// One repo and the folders in it that hold `broods/`.
async function inspectFor(
  ctx: ActionCtx,
  authId: string,
  args: {
    projectId?: Id<"projects">;
    installationId: number;
    repoId: number;
  },
): Promise<{
  repo: GitHubRepo;
  roots: Infer<typeof rootValidator>[];
  branches: string[];
}> {
  const app = requireGitHubApp();
  await requireInstallation(ctx, authId, args.projectId, args.installationId);
  const token = await installationToken(app, args.installationId);
  const repo = await getRepo(app, token, args.installationId, args.repoId);
  const [roots, branches] = await Promise.all([
    findBroodsRoots(app, token, repo.fullName, repo.defaultBranch),
    listBranches(app, token, repo.fullName),
  ]);

  return {
    repo: repo,
    roots: roots,
    branches: [
      repo.defaultBranch,
      ...branches.filter((branch) => branch !== repo.defaultBranch),
    ],
  };
}

/**
 * Links an existing repo: mints a project key per mapped stage, seals them
 * into the repo, and commits the workflow to each mapped branch (through a PR
 * when a branch is protected). Linking the project's own repo again changes
 * its branches in place; another repo needs an unlink first.
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

    return await linkFor(ctx, user.id, projectId, target);
  },
});

// Mints the mapped stages' keys and links the repo with them, revoking them on failure.
async function linkFor(
  ctx: ActionCtx,
  authId: string,
  projectId: Id<"projects">,
  asked: LinkTarget,
): Promise<ProjectRepo> {
  // A blank branch is no answer, so it takes the default rather than "".
  const target = {
    ...asked,
    productionBranch: blankToUnset(asked.productionBranch),
    developmentBranch: blankToUnset(asked.developmentBranch),
  };
  const app = requireGitHubApp();
  await requireInstallation(ctx, authId, projectId, target.installationId);
  const keys = await ctx.runMutation(internal.github.mintLinkKeys, {
    authId: authId,
    projectId: projectId,
    repoId: target.repoId,
    productionBranch: target.productionBranch,
    developmentBranch: target.developmentBranch,
  });

  return await withKeys(ctx, keys, (): Promise<ProjectRepo> =>
    linkTarget(ctx, app, authId, keys, target),
  );
}

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

    await clearLink(ctx, await requireLinkAccess(ctx, user.id, projectId));

    return null;
  },
});

/** `unlinkRepo` for a `broods login` token. */
export const unlinkFor = internalMutation({
  args: { authId: v.string(), projectId: v.id("projects") },
  returns: v.null(),
  handler: async (ctx, { authId, projectId }): Promise<null> => {
    await clearLink(ctx, await requireLinkAccess(ctx, authId, projectId));

    return null;
  },
});

/**
 * `broods github` with a `broods login` token, in the org the token acts in:
 * the project's link and the org's accounts (`GET`), the repos it may link
 * (`GET /repos`), a link (`POST /link`), an unlink (`DELETE /link`), and the
 * App's install page (`POST /connect`). `?project=` names the project.
 */
export const cli = httpAction(async (ctx, request): Promise<Response> => {
  try {
    const tokenHash = await cliLoginTokenHash(request);
    const caller = tokenHash
      ? await ctx.runMutation(internal.cli.auth.resolveCliToken, {
          tokenHash: tokenHash,
        })
      : null;
    if (!caller) {
      return jsonError(401, "GitHub commands need a `broods login` token");
    }
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname.replace(/^\/v1\/account\/github/, "")}`;
    if (route === "POST /connect") {
      return json(
        await ctx.runMutation(internal.github.beginFor, {
          authId: caller.authId,
          orgId: caller.orgId,
        }),
      );
    }
    const projectId = await ctx.runQuery(internal.github.cliProject, {
      orgId: caller.orgId,
      slug: url.searchParams.get("project") ?? "",
    });
    if (!projectId) return jsonError(404, "Project not found");
    if (route === "GET ") {
      return json(
        await ctx.runQuery(internal.github.statusFor, {
          authId: caller.authId,
          orgId: caller.orgId,
          projectId: projectId,
        }),
      );
    }
    if (route === "GET /repos") {
      return json({
        repos: await listReposFor(ctx, caller.authId, projectId),
      });
    }
    if (route === "DELETE /link") {
      await ctx.runMutation(internal.github.unlinkFor, {
        authId: caller.authId,
        projectId: projectId,
      });

      return json({ unlinked: true });
    }
    if (route === "POST /link") {
      const body = (await request.json()) as CliLinkRequest;

      return json({
        repo: await linkByName(ctx, caller.authId, projectId, body),
      });
    }

    return jsonError(404, "Not found");
  } catch (error) {
    const clientError = clientErrorResponse(error);
    if (clientError) return clientError;
    if (error instanceof SyntaxError) {
      return jsonError(400, "Request body is not JSON");
    }
    console.error("GitHub CLI request failed", error);

    return jsonError(500, "GitHub request failed");
  }
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
        runAttempt: run.run_attempt,
        sha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion ?? undefined,
        url: run.html_url,
      });
      if (run.status === "completed")
        await ctx.runMutation(internal.stageSources.verifyRun, {
          repoId: payload.repository.id,
          branch: run.head_branch,
          sha: run.head_sha,
          conclusion: run.conclusion ?? undefined,
          url: run.html_url,
          startedAt: Date.parse(run.run_started_at ?? "") || 0,
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

    return await orgInstallations(ctx, orgId);
  },
});

/** A project of the org by its slug or name, for a `broods login` token. */
export const cliProject = internalQuery({
  args: { orgId: v.id("orgs"), slug: v.string() },
  returns: v.union(v.id("projects"), v.null()),
  handler: async (ctx, { orgId, slug }): Promise<Id<"projects"> | null> => {
    if (!slug.trim()) return null;
    const project = await ctx.db
      .query("projects")
      .withIndex("by_orgId_and_slug", (q) =>
        q.eq("orgId", orgId).eq("slug", slugifyName(slug)),
      )
      .first();

    return project?._id ?? null;
  },
});

/** Removes and answers the caller's pending round trip for `state`. */
export const takeSignIn = internalMutation({
  args: { state: v.string(), authId: v.string() },
  returns: v.object({
    orgId: githubSignInsFields.orgId,
    returnTo: githubSignInsFields.returnTo,
    createRepo: githubSignInsFields.createRepo,
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

/** Upserts the installations a signed-in GitHub user administers for the org. */
export const storeInstallations = internalMutation({
  args: { orgId: v.id("orgs"), installations: v.array(installationValidator) },
  returns: v.null(),
  handler: async (ctx, { orgId, installations }): Promise<null> => {
    // The org may have been deleted while the user was on GitHub.
    if (!(await ctx.db.get(orgId))) return null;
    const existing = await ctx.db
      .query("githubInstallations")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .collect();
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

/** Mints a GitHub Actions key for each mapped stage, creating the stage when missing. */
export const mintLinkKeys = internalMutation({
  /** `repoId`: an existing repo, refused when another project already deploys from it. */
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    repoId: v.optional(v.number()),
    /**
     * The link's branch asks, as in `LinkTarget`. Production deploys when a
     * branch is named for it, or by default when the project already has a
     * Production stage; Development unless null.
     */
    productionBranch: linkTargetValidator.fields.productionBranch,
    developmentBranch: linkTargetValidator.fields.developmentBranch,
  },
  returns: v.object({
    projectId: v.id("projects"),
    projectSlug: v.string(),
    keyIds: v.array(v.id("deployKeys")),
    stageIds: v.array(v.id("stages")),
    previousBranches: v.array(v.string()),
    production: v.optional(v.string()),
    development: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    { authId, projectId, repoId, productionBranch, developmentBranch },
  ): Promise<LinkKeys> => {
    const project = await requireLinkAccess(ctx, authId, projectId);
    // Caught before a stage is made; one that only defaults can clash shows up on GitHub.
    if (productionBranch && productionBranch === developmentBranch) {
      throw new ClientError(
        `Production and Development need different branches; both are ${productionBranch}.`,
      );
    }
    const existing = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectId))
      .collect();
    const production =
      productionBranch === undefined
        ? existing.some((stage) => stage.kind === "production")
        : productionBranch !== null;
    const stages = STAGES.filter((stage) =>
      stage === "production" ? production : developmentBranch !== null,
    );
    if (stages.length === 0) {
      throw new ClientError("Map at least one stage to a branch.");
    }
    requireLinkable(project, repoId);
    if ((project.linkClaim?.expiresAt ?? 0) > Date.now()) {
      throw new ClientError(
        `${project.name} is linking a repo right now. Try again shortly.`,
      );
    }
    if (repoId !== undefined) {
      // Written in the same transaction as the check, so two links racing for
      // one repo conflict and the retried one sees this claim.
      await requireRepoFree(ctx, repoId, projectId);
      await ctx.db.patch(projectId, {
        linkClaim: {
          repoId: repoId,
          expiresAt: Date.now() + LINK_CLAIM_TTL_MS,
        },
      });
    }
    const member = await userByAuthId(ctx, authId);
    if (!member) throw new Error("User row not found");
    const mint = async (
      stageName: string,
    ): Promise<{
      _id: Id<"deployKeys">;
      token: string;
    }> => {
      const stage = await ensureStage(ctx, project, stageName);
      if (!existing.some((entry) => entry._id === stage._id)) {
        keys.stageIds.push(stage._id);
      }
      // A role may write keys on the project but not on Production.
      await requireDashboardPermission(
        ctx,
        project.orgId,
        member,
        "keys:write",
        {
          projectId: projectId,
          stageId: stage._id,
        },
      );

      return await insertDeployKey(ctx, {
        orgId: project.orgId,
        projectId: projectId,
        stageId: stage._id,
        name: "GitHub Actions",
        description: "Deploys on push from the linked GitHub repo.",
        createdBy: member._id,
      });
    };
    const keys: LinkKeys = {
      projectId: projectId,
      projectSlug: project.slug,
      keyIds: [],
      stageIds: [],
      previousBranches: [
        project.repo?.productionBranch,
        project.repo?.developmentBranch,
      ].filter((branch): branch is string => branch !== undefined),
    };
    for (const stage of stages) {
      const key = await mint(stage);
      keys.keyIds.push(key._id);
      keys[stage] = key.token;
    }

    return keys;
  },
});

/**
 * Deletes the keys and stages a link made but never used, and its repo claim, after a GitHub call
 * failed.
 */
export const revokeKeys = internalMutation({
  args: {
    projectId: v.id("projects"),
    keyIds: v.array(v.id("deployKeys")),
    /** Stages the minting added; nothing but its keys is in them yet. */
    stageIds: v.array(v.id("stages")),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, keyIds, stageIds }): Promise<null> => {
    for (const keyId of keyIds) {
      if (await ctx.db.get(keyId)) await ctx.db.delete(keyId);
    }
    for (const stageId of stageIds) {
      const stage = await ctx.db.get(stageId);
      if (stage) {
        await deleteStageContents(ctx, stage);
        await ctx.db.delete(stageId);
      }
    }
    if (await ctx.db.get(projectId)) {
      await ctx.db.patch(projectId, { linkClaim: undefined });
    }

    return null;
  },
});

/** Stores the link once GitHub holds the keys, revoking a relinked repo's old ones. */
export const saveLink = internalMutation({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    repo: projectRepoValidator,
  },
  returns: v.null(),
  handler: async (ctx, { authId, projectId, repo }): Promise<null> => {
    // Rechecked here: another link may have landed while GitHub was set up.
    const project = await requireLinkAccess(ctx, authId, projectId);
    requireLinkable(project, repo.repoId);
    await requireRepoFree(ctx, repo.repoId, projectId);
    // GitHub holds the new keys by now, so the old ones can go.
    for (const keyId of project.repo?.deployKeyIds ?? []) {
      if (repo.deployKeyIds.includes(keyId)) continue;
      if (await ctx.db.get(keyId)) await ctx.db.delete(keyId);
    }
    await ctx.db.patch(projectId, {
      repo: repo,
      linkClaim: undefined,
      updatedAt: Date.now(),
    });

    return null;
  },
});

/** Keeps the latest workflow run per linked project and branch. */
export const recordDeploy = internalMutation({
  args: {
    repoId: v.number(),
    branch: v.string(),
    runId: v.number(),
    runAttempt: v.optional(v.number()),
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
      if (row && isStaleRun(row, run)) continue;
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

/**
 * Whether a delivery is older than the stored run: an earlier run, an earlier
 * attempt of the same run, or a late in-progress event for an attempt that
 * already finished. A rerun is a higher attempt, so it shows while it runs.
 */
function isStaleRun(
  row: Doc<"githubDeploys">,
  run: { runId: number; runAttempt?: number; status: string },
): boolean {
  if (row.runId !== run.runId) return row.runId > run.runId;
  const stored = row.runAttempt ?? 0;
  const incoming = run.runAttempt ?? 0;
  if (stored !== incoming) return stored > incoming;

  return row.status === "completed" && run.status !== "completed";
}

// A branch with surrounding space trimmed; a blank one is unset.
function blankToUnset(
  branch: string | null | undefined,
): string | null | undefined {
  if (typeof branch !== "string") return branch;

  return branch.trim() || undefined;
}

// The org's owner, or any member.
async function isOrgMember(
  ctx: QueryCtx,
  org: Doc<"orgs">,
  member: Doc<"users">,
): Promise<boolean> {
  return (
    org.ownerAuthId === member.authId ||
    (await getOrgMembership(ctx, org._id, member._id)) !== null
  );
}

// The org's owner, or a member with the admin role.
async function isOrgAdmin(
  ctx: QueryCtx,
  org: Doc<"orgs">,
  member: Doc<"users">,
): Promise<boolean> {
  if (org.ownerAuthId === member.authId) return true;
  const membership = await getOrgMembership(ctx, org._id, member._id);

  return membership !== null && orgRoleMeets(membership.role, "admin");
}

// A dashboard path, or undefined when a URL parser resolves it to another origin (`//x`, `/\\x`).
function localPath(value: string | undefined): string | undefined {
  if (!value?.startsWith("/")) return undefined;
  const base = "https://dashboard.invalid";

  return new URL(value, base).origin === base ? value : undefined;
}

// The org's connected accounts, as the dashboard and a link see them.
async function orgInstallations(
  ctx: QueryCtx,
  orgId: Id<"orgs">,
): Promise<Infer<typeof installationValidator>[]> {
  const rows = await ctx.db
    .query("githubInstallations")
    .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
    .collect();

  return rows.map((row) => ({
    installationId: row.installationId,
    login: row.login,
    accountType: row.accountType,
  }));
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
/** `orgId`, or the caller's active org, when they are its owner or an admin. */
async function requireOrgAdmin(
  ctx: QueryCtx,
  authId: string,
  orgId?: Id<"orgs">,
): Promise<Id<"orgs">> {
  const member = await userByAuthId(ctx, authId);
  const org = member
    ? orgId
      ? await ctx.db.get(orgId)
      : await getActiveOrgForUser(ctx, member._id)
    : null;
  if (!member || !org) throw new ClientError("Join an organization first.");
  if (!(await isOrgAdmin(ctx, org, member))) {
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
  const claims = await ctx.db
    .query("projects")
    .withIndex("by_linkClaimRepoId", (q) => q.eq("linkClaim.repoId", repoId))
    .collect();
  const linking = claims.find(
    (claim) =>
      claim._id !== projectId && (claim.linkClaim?.expiresAt ?? 0) > Date.now(),
  );
  if (linking) {
    throw new ClientError(
      `Project ${linking.name} is linking that repo right now. Try again shortly.`,
    );
  }
}

// One repo per project. Linking the linked repo again changes its branches in
// place; another repo would leave the first one's keys and workflow behind.
function requireLinkable(
  project: Doc<"projects">,
  repoId: number | undefined,
): void {
  if (project.repo && project.repo.repoId !== repoId) {
    throw new ClientError(
      `${project.name} already deploys from ${project.repo.fullName}. Unlink it first.`,
    );
  }
}

// Secrets, the development branch, the workflow on both branches, then the stored link.
async function linkTarget(
  ctx: ActionCtx,
  app: GitHubApp,
  authId: string,
  keys: LinkKeys,
  target: LinkTarget,
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
  );
  // A workflow for a folder with no broods/ would fail every push.
  if (!root) {
    throw new ClientError(
      `${repo.fullName} has no broods/ in ${target.rootDirectory || "its root"} on ${repo.defaultBranch}.`,
    );
  }
  // The stages minted a key are the ones the repo deploys. With no
  // Production, the default branch deploys Development.
  const branches: Partial<Record<Stage, string>> = {
    ...(keys.production
      ? { production: target.productionBranch?.trim() || repo.defaultBranch }
      : {}),
    ...(keys.development
      ? {
          development:
            target.developmentBranch?.trim() ||
            (keys.production
              ? developmentBranchFor(repo.defaultBranch)
              : repo.defaultBranch),
        }
      : {}),
  };
  // One branch for both would deploy every push to Production and Development at once.
  if (branches.production && branches.production === branches.development) {
    throw new ClientError(
      `Production and Development need different branches; both are ${branches.production}.`,
    );
  }
  // Sealed before the workflow lands, so its first run finds the keys.
  const environments = await sealDeployKeys(app, token, repo.fullName, {
    ...(branches.production && keys.production
      ? {
          production: { branch: branches.production, token: keys.production },
        }
      : {}),
    ...(branches.development && keys.development
      ? {
          development: {
            branch: branches.development,
            token: keys.development,
          },
        }
      : {}),
  });
  if (branches.development && branches.development !== repo.defaultBranch) {
    await createBranch(
      app,
      token,
      repo.fullName,
      repo.defaultBranch,
      branches.development,
    );
  }
  const workflow = deployWorkflow({
    ...root,
    projectSlug: keys.projectSlug,
    baseUrl: target.baseUrl,
    productionBranch: branches.production,
    developmentBranch: branches.development,
    environments: environments,
  });
  const pulls: Array<string | undefined> = [];
  for (const branch of new Set(Object.values(branches))) {
    pulls.push(
      await commitWorkflow(app, token, repo.fullName, branch, workflow),
    );
  }
  await retireBranches(
    app,
    token,
    repo.fullName,
    keys.previousBranches.filter(
      (branch) => !Object.values(branches).includes(branch),
    ),
    workflow,
  );

  const linked: ProjectRepo = {
    installationId: repo.installationId,
    repoId: repo.repoId,
    fullName: repo.fullName,
    rootDirectory: root.rootDirectory,
    productionBranch: branches.production,
    developmentBranch: branches.development,
    deployKeyIds: keys.keyIds,
    protectedSecrets: environments,
    setupPullRequestUrl: pulls.find((url) => url !== undefined),
  };
  await ctx.runMutation(internal.github.saveLink, {
    authId: authId,
    projectId: keys.projectId,
    repo: linked,
  });

  return linked;
}

// Branches a remap dropped get the new workflow too, whose job skips them, or
// their old one would keep deploying with the stage's new repo secret.
async function retireBranches(
  app: GitHubApp,
  token: string,
  fullName: string,
  dropped: string[],
  workflow: string,
): Promise<void> {
  for (const branch of dropped) {
    await commitWorkflow(app, token, fullName, branch, workflow).catch(
      (error: unknown) => {
        // A branch deleted since has no workflow left to run.
        if (error instanceof GitHubApiError && error.status === 404) return;
        throw error;
      },
    );
  }
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
    await ctx.runMutation(internal.github.revokeKeys, {
      projectId: keys.projectId,
      keyIds: keys.keyIds,
      stageIds: keys.stageIds,
    });
    throw error;
  }
}
