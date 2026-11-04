import { v, type Infer } from "convex/values";
import { z } from "zod/mini";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalAction,
  internalQuery,
  mutation,
  type ActionCtx,
} from "./_generated/server";
import { stageTicketSecret } from "./agent/deployments";
import { authKit } from "./auth";
import { cliLoginTarget, insertCliToken } from "./cli/auth";
import { sealApplyTicket } from "./model/applyTicket";
import { accountIdForProject } from "./model/auditEvents";
import { ClientError } from "./model/clientError";
import {
  broodsFolder,
  commitFiles,
  installationToken,
  isAgentEditable,
  branchHead,
  readBroodsFolder,
  readStageSourceAt,
  requireGitHubApp,
} from "./model/github";
import { getOwnedStage, getStageForWrite } from "./model/ownership/stage";
import { serviceEnv, serviceHeaders } from "./model/serviceBridge";
import {
  STAGE_SOURCE_LIMITS,
  stageSourceHash,
  stageSourceProblem,
  stageSourceSchema,
  type StageSource,
  type StageSourceOrigin,
} from "./model/stageSource";
import { storeStageSync } from "./model/stageSourceStore";
import { sealUserToken, USER_TOKEN_MAX_TTL_MS } from "./model/userToken";

const AGENT_PATH =
  /^\/v1\/projects\/([^/]+)\/stages\/([^/]+)\/agents\/([^/]+)\/?$/;

const sessionValidator = v.object({
  agentId: v.string(),
  expiresAt: v.number(),
  runtimeKey: v.string(),
  url: v.string(),
  userToken: v.string(),
});

const repoFileValidator = v.object({ content: v.string(), path: v.string() });
const commitFileValidator = v.object({
  content: v.union(v.string(), v.null()),
  path: v.string(),
});

const repoTargetValidator = v.object({
  branch: v.string(),
  fullName: v.string(),
  installationId: v.number(),
  rootDirectory: v.string(),
});

const applyResultValidator = v.object({
  revision: v.number(),
  manifestHash: v.string(),
  durationMs: v.number(),
  phases: v.record(v.string(), v.number()),
  phase: v.union(v.literal("verifying"), v.literal("deployed")),
  commitSha: v.optional(v.string()),
});

const applyTargetValidator = v.object({
  accountId: v.string(),
  project: v.string(),
  stage: v.string(),
  revision: v.union(v.number(), v.null()),
  hash: v.optional(v.string()),
});

const applyRunAnswer = z.object({
  ok: z.boolean(),
  output: z.string(),
  phases: z.record(z.string(), z.number()),
});

type ApplyResult = Infer<typeof applyResultValidator>;
type ApplyTarget = Infer<typeof applyTargetValidator>;
type DockSession = Infer<typeof sessionValidator>;
type RepoTarget = Infer<typeof repoTargetValidator>;

// The dock talks to one Broods agent per deployment, as the signed-in user; null keeps its planner.
export const session = mutation({
  args: {
    conversationKey: v.optional(v.string()),
    projectId: v.optional(v.id("projects")),
  },
  returns: v.union(sessionValidator, v.null()),
  handler: async (
    ctx,
    { conversationKey, projectId },
  ): Promise<DockSession | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");
    const agent = dockAgent();
    if (!agent) return null;

    const expiresAt = Date.now() + USER_TOKEN_MAX_TTL_MS;
    // Only an owner or admin holds the whole account, so only they lend the agent a login: for
    // the open project's org, which need not be the active one.
    const project = projectId ? await ctx.db.get(projectId) : null;
    const target =
      projectId && !project
        ? new ClientError("Project not found", "not_found")
        : await cliLoginTarget(ctx, authUser.id, project?.orgId);
    const credential =
      target instanceof ClientError
        ? undefined
        : await insertCliToken(
            ctx,
            {
              authId: authUser.id,
              ...target,
              lentToAgent: true,
              ...(conversationKey ? { lentConversation: conversationKey } : {}),
            },
            expiresAt,
          );
    const userToken = await sealUserToken(
      {
        userId: authUser.id,
        ...(credential !== undefined ? { credential: credential } : {}),
        expiresAt: expiresAt,
      },
      agent.userTokenSecret,
    );

    return {
      agentId: agent.agentId,
      expiresAt: expiresAt,
      runtimeKey: agent.runtimeKey,
      url: agent.url,
      userToken: userToken,
    };
  },
});

// What the agent reads before it edits: the stage's `broods/` folder on the branch it deploys from.
export const repoFiles = action({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: v.union(
    v.object({
      baseSha: v.string(),
      branch: v.string(),
      files: v.array(repoFileValidator),
      fullName: v.string(),
      omitted: v.number(),
    }),
    v.null(),
  ),
  handler: async (
    ctx,
    args,
  ): Promise<{
    baseSha: string;
    branch: string;
    files: Infer<typeof repoFileValidator>[];
    fullName: string;
    omitted: number;
  } | null> => {
    const target = await repoTarget(ctx, args, false);
    if (!target) return null;
    const app = requireGitHubApp();
    const token = await installationToken(app, target.installationId);

    return {
      branch: target.branch,
      fullName: target.fullName,
      ...(await readBroodsFolder(
        app,
        token,
        target.fullName,
        target.branch,
        target.rootDirectory,
      )),
    };
  },
});

// Applies the agent's edit as one commit; a branch that refuses the write gets a pull request.
export const commitChange = action({
  args: {
    baseSha: v.string(),
    branch: v.string(),
    files: v.array(commitFileValidator),
    fullName: v.string(),
    message: v.string(),
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.object({
    sha: v.string(),
    url: v.string(),
    viaPullRequest: v.boolean(),
  }),
  handler: async (
    ctx,
    { baseSha, branch, files, fullName, message, ...args },
  ): Promise<{ sha: string; url: string; viaPullRequest: boolean }> => {
    const target = await repoTarget(ctx, args, true);
    if (!target) {
      throw new ClientError("This stage does not deploy from a repo.");
    }
    if (target.fullName !== fullName || target.branch !== branch) {
      throw new ClientError(
        `This stage now deploys from ${target.fullName} ${target.branch}. Ask again.`,
      );
    }
    const folder = broodsFolder(target.rootDirectory);
    const outside = files.find((file) => !isAgentEditable(folder, file.path));
    if (outside || files.length === 0) {
      throw new ClientError(
        `The agent may only change files in ${folder}${outside ? `, not ${outside.path}` : ""}.`,
      );
    }
    const app = requireGitHubApp();

    return await commitFiles(
      app,
      await installationToken(app, target.installationId),
      target.fullName,
      target.branch,
      files,
      message.trim() || "Update broods/ from the dashboard",
      baseSha,
    );
  },
});

// The fast path: the approved files deploy from a compile sandbox with a ticket only this mints,
// become the stage's source, then go to a linked branch, whose CI must land on the same hash.
export const apply = action({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    baseRevision: v.union(v.number(), v.null()),
    files: v.array(repoFileValidator),
    message: v.string(),
  },
  returns: applyResultValidator,
  handler: async (ctx, args): Promise<ApplyResult> => {
    const { authId, target } = await writableTarget(ctx, args);
    // A retry of a draft that already deployed finds its own revision on top: not a conflict.
    const retry = target.hash === (await stageSourceHash(args.files));
    if (target.revision !== args.baseRevision && !retry)
      throw new ClientError(
        `The stage's source is now revision ${target.revision ?? "none"}. Review the new diff and apply again.`,
        "conflict",
      );
    const repo = await ctx.runQuery(internal.agentDock.linkedBranch, {
      authId: authId,
      projectId: args.projectId,
      stageId: args.stageId,
      write: true,
    });
    const app = repo ? requireGitHubApp() : undefined;
    const token =
      repo && app ? await installationToken(app, repo.installationId) : "";
    const head =
      repo && app
        ? await branchHead(app, token, repo.fullName, repo.branch)
        : undefined;
    // The commit carries the diff from the stored revision the branch head holds.
    const base = head
      ? await ctx.runAction(internal.agentDock.storedSource, {
          stageId: args.stageId,
          commitSha: head,
        })
      : null;
    if (head && !base)
      throw new ClientError(
        `${repo?.branch} has commits the stage does not run. Sync first, then apply.`,
        "conflict",
      );
    const deployed = await deployFiles(
      ctx,
      authId,
      args,
      target,
      { files: args.files },
      "apply",
    );
    if (!repo || !app || !head) {
      await ctx.runMutation(internal.stageSources.setVerification, {
        stageId: args.stageId,
        revision: deployed.revision,
        verification: { phase: "deployed" },
      });

      return { ...deployed, phase: "deployed" };
    }
    const committed = await commitFiles(
      app,
      token,
      repo.fullName,
      repo.branch,
      changedFiles(base?.files ?? [], args.files).map((file) => ({
        path: `${repo.rootDirectory ? `${repo.rootDirectory}/` : ""}${file.path}`,
        content: file.content,
      })),
      args.message.trim() || "Update broods/ from the dashboard",
      head,
    );
    // A pull request (protected branch) stays verifying, so drift offers no Sync that undoes it.
    await ctx.runMutation(internal.stageSources.setVerification, {
      stageId: args.stageId,
      revision: deployed.revision,
      verification: { phase: "verifying", runUrl: committed.url },
      commitSha: committed.sha,
    });

    return { ...deployed, phase: "verifying", commitSha: committed.sha };
  },
});

/** The one button behind "out of sync": redeploys the branch head when linked, else the source. */
export const sync = action({
  args: { projectId: v.id("projects"), stageId: v.id("stages") },
  returns: applyResultValidator,
  handler: async (ctx, args): Promise<ApplyResult> => {
    const { authId, target } = await writableTarget(ctx, args);
    const repo = await ctx.runQuery(internal.agentDock.linkedBranch, {
      authId: authId,
      projectId: args.projectId,
      stageId: args.stageId,
      write: true,
    });
    const app = repo ? requireGitHubApp() : undefined;
    const source =
      repo && app
        ? await readStageSourceAt(
            app,
            await installationToken(app, repo.installationId),
            repo.fullName,
            repo.branch,
            repo.rootDirectory,
          )
        : await ctx.runAction(internal.agentDock.storedSource, {
            stageId: args.stageId,
          });
    if (!source)
      throw new ClientError("This stage has no stored source to sync.");
    const deployed = await deployFiles(
      ctx,
      authId,
      args,
      target,
      { files: source.files, ...(source.sha ? { commitSha: source.sha } : {}) },
      repo ? "github" : "apply",
    );
    await ctx.runMutation(internal.stageSources.setVerification, {
      stageId: args.stageId,
      revision: deployed.revision,
      verification: { phase: "deployed" },
    });

    return { ...deployed, phase: "deployed" };
  },
});

/** A push CI deployed that no Apply made: its files become the source, at the hash CI left. */
export const snapshotRepo = internalAction({
  args: { stageId: v.id("stages"), sha: v.string(), since: v.number() },
  returns: v.null(),
  handler: async (ctx, { stageId, sha, since }): Promise<null> => {
    const repo = await ctx.runQuery(internal.agentDock.stageRepo, {
      stageId: stageId,
    });
    // Only a run that synced the stage left it on this commit's source.
    const manifestHash = await ctx.runQuery(internal.stageSources.syncedSince, {
      stageId: stageId,
      since: since,
    });
    if (!repo || !manifestHash) return null;
    const app = requireGitHubApp();
    const source = await readStageSourceAt(
      app,
      await installationToken(app, repo.installationId),
      repo.fullName,
      sha,
      repo.rootDirectory,
    );
    if (stageSourceProblem(source.files)) return null;
    await storeStageSync(
      ctx,
      stageId,
      manifestHash,
      { files: source.files, commitSha: sha },
      "github",
    );

    return null;
  },
});

/** The newest stored source, or the newest one made from `commitSha`. */
export const storedSource = internalAction({
  args: { stageId: v.id("stages"), commitSha: v.optional(v.string()) },
  returns: v.union(
    v.object({
      files: v.array(repoFileValidator),
      sha: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (
    ctx,
    { stageId, commitSha },
  ): Promise<{
    files: Infer<typeof repoFileValidator>[];
    sha?: string;
  } | null> => {
    const url = await ctx.runQuery(internal.agentDock.sourceUrl, {
      stageId: stageId,
      ...(commitSha ? { commitSha: commitSha } : {}),
    });
    if (!url) return null;
    const parsed = stageSourceSchema.safeParse(await (await fetch(url)).json());

    return parsed.success ? { files: parsed.data.files } : null;
  },
});

export const sourceUrl = internalQuery({
  args: { stageId: v.id("stages"), commitSha: v.optional(v.string()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { stageId, commitSha }): Promise<string | null> => {
    const recent = await ctx.db
      .query("stageSources")
      .withIndex("by_stageId_and_revision", (q) => q.eq("stageId", stageId))
      .order("desc")
      .take(STAGE_SOURCE_LIMITS.revisions);
    const row = commitSha
      ? recent.find((entry) => entry.commitSha === commitSha)
      : recent[0];

    return row ? await ctx.storage.getUrl(row.storageId) : null;
  },
});

export const stageRepo = internalQuery({
  args: { stageId: v.id("stages") },
  returns: v.union(repoTargetValidator, v.null()),
  handler: async (ctx, { stageId }): Promise<RepoTarget | null> => {
    const stage = await ctx.db.get(stageId);
    const repo = stage ? (await ctx.db.get(stage.projectId))?.repo : undefined;
    if (!stage || !repo) return null;
    const branch =
      stage.kind === "production"
        ? repo.productionBranch
        : repo.developmentBranch;

    return branch
      ? {
          branch: branch,
          fullName: repo.fullName,
          installationId: repo.installationId,
          rootDirectory: repo.rootDirectory,
        }
      : null;
  },
});

export const applyTarget = internalQuery({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.union(applyTargetValidator, v.null()),
  handler: async (
    ctx,
    { authId, projectId, stageId },
  ): Promise<ApplyTarget | null> => {
    const stage = await getStageForWrite(ctx, authId, stageId);
    if (stage?.projectId !== projectId) return null;
    const project = await ctx.db.get(projectId);
    const accountId = project
      ? await accountIdForProject(ctx, projectId)
      : null;
    if (!project || !accountId) return null;
    const newest = await ctx.db
      .query("stageSources")
      .withIndex("by_stageId_and_revision", (q) => q.eq("stageId", stageId))
      .order("desc")
      .first();

    return {
      accountId: accountId,
      project: project.slug,
      // The CLI's spelling: the dashboard shows `Development`, `broods` takes `development`.
      stage: stage.name.toLowerCase(),
      revision: newest?.revision ?? null,
      ...(newest ? { hash: newest.hash } : {}),
    };
  },
});

/** The repo branch a stage deploys from, when the caller may read (or `write`) that stage. */
export const linkedBranch = internalQuery({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    write: v.boolean(),
  },
  returns: v.union(repoTargetValidator, v.null()),
  handler: async (
    ctx,
    { authId, projectId, stageId, write },
  ): Promise<RepoTarget | null> => {
    const stage = write
      ? await getStageForWrite(ctx, authId, stageId)
      : await getOwnedStage(ctx, authId, stageId);
    if (stage?.projectId !== projectId) return null;
    const repo = (await ctx.db.get(projectId))?.repo;
    if (!repo) return null;
    const branch =
      stage.kind === "production"
        ? repo.productionBranch
        : repo.developmentBranch;
    if (!branch) return null;

    return {
      branch: branch,
      fullName: repo.fullName,
      installationId: repo.installationId,
      rootDirectory: repo.rootDirectory,
    };
  },
});

async function repoTarget(
  ctx: ActionCtx,
  args: { projectId: Id<"projects">; stageId: Id<"stages"> },
  write: boolean,
): Promise<RepoTarget | null> {
  const user = await authKit.getAuthUser(ctx);
  if (!user) throw new Error("User not found or not authenticated");
  return await ctx.runQuery(internal.agentDock.linkedBranch, {
    authId: user.id,
    projectId: args.projectId,
    stageId: args.stageId,
    write: write,
  });
}

function dockAgent(): {
  agentId: string;
  runtimeKey: string;
  url: string;
  userTokenSecret: string;
} | null {
  const url = process.env.BROODS_AGENT_URL;
  const agentId = process.env.BROODS_AGENT_ID;
  const runtimeKey = process.env.BROODS_AGENT_RUNTIME_KEY;
  const userTokenSecret = process.env.BROODS_AGENT_USER_TOKEN_SECRET;
  if (!url || !agentId || !runtimeKey || !userTokenSecret) return null;
  if (!URL.canParse(url) || !AGENT_PATH.test(new URL(url).pathname))
    return null;

  return {
    agentId: agentId,
    runtimeKey: runtimeKey,
    url: url.replace(/\/+$/, ""),
    userTokenSecret: userTokenSecret,
  };
}

// What a commit must carry to turn `base` into `next`; null content deletes.
function changedFiles(
  base: readonly { path: string; content: string }[],
  next: readonly { path: string; content: string }[],
): { path: string; content: string | null }[] {
  const before = new Map(base.map((file) => [file.path, file.content]));
  const kept = new Set(next.map((file) => file.path));

  return [
    ...next.filter((file) => before.get(file.path) !== file.content),
    ...base
      .filter((file) => !kept.has(file.path))
      .map((file) => ({ path: file.path, content: null })),
  ];
}

// Deploys `source` from the compile sandbox as `authId`, then stores it as the next revision.
async function deployFiles(
  ctx: ActionCtx,
  authId: string,
  ids: { projectId: Id<"projects">; stageId: Id<"stages"> },
  target: ApplyTarget,
  source: StageSource,
  origin: StageSourceOrigin,
): Promise<Omit<ApplyResult, "phase" | "commitSha">> {
  const problem = stageSourceProblem(source.files);
  if (problem) throw new ClientError(`Cannot deploy: ${problem}.`);
  const lock = source.files.find((file) => file.path === "bun.lock");
  const startedAt = Date.now();
  const service = serviceEnv();
  const response = await fetch(`${service.url}/v1/apply-runs`, {
    method: "POST",
    headers: serviceHeaders(target.accountId, service.secret),
    body: JSON.stringify({
      accountId: target.accountId,
      projectId: ids.projectId,
      stageId: ids.stageId,
      project: target.project,
      stage: target.stage,
      ticket: await sealApplyTicket(
        {
          accountId: target.accountId,
          projectId: ids.projectId,
          stageId: ids.stageId,
          authId: authId,
        },
        stageTicketSecret(),
      ),
      lockHash: await stageSourceHash(lock ? [lock] : []),
      files: source.files,
    }),
  });
  const run = applyRunAnswer.safeParse(await response.json());
  if (!response.ok || !run.success)
    throw new Error(`Apply run failed with status ${response.status}`);
  if (!run.data.ok)
    throw new ClientError(`The deploy failed:\n${run.data.output}`);
  const manifestHash = await ctx.runQuery(internal.stageSources.syncedSince, {
    stageId: ids.stageId,
    since: startedAt,
  });
  if (!manifestHash)
    throw new ClientError("The deploy finished without syncing the stage.");
  const revision = await storeStageSync(
    ctx,
    ids.stageId,
    manifestHash,
    source,
    origin,
  );

  return {
    revision: revision ?? 0,
    manifestHash: manifestHash,
    durationMs: Date.now() - startedAt,
    phases: run.data.phases,
  };
}

async function writableTarget(
  ctx: ActionCtx,
  args: { projectId: Id<"projects">; stageId: Id<"stages"> },
): Promise<{ authId: string; target: ApplyTarget }> {
  const user = await authKit.getAuthUser(ctx);
  if (!user) throw new Error("User not found or not authenticated");
  const target = await ctx.runQuery(internal.agentDock.applyTarget, {
    authId: user.id,
    projectId: args.projectId,
    stageId: args.stageId,
  });
  if (!target) throw new ClientError("You cannot deploy this stage.");

  return { authId: user.id, target: target };
}
