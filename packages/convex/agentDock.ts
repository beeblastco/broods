import { v, type Infer } from "convex/values";
import { z } from "zod/mini";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalQuery,
  mutation,
  type ActionCtx,
} from "./_generated/server";
import { stageTicketSecret } from "./agent/deployments";
import { authKit } from "./auth";
import { sealApplyTicket } from "./model/applyTicket";
import { accountIdForProject } from "./model/auditEvents";
import { ClientError } from "./model/clientError";
import {
  broodsFolder,
  commitFiles,
  installationToken,
  isAgentEditable,
  readBroodsFolder,
  requireGitHubApp,
} from "./model/github";
import { getOwnedStage, getStageForWrite } from "./model/ownership/stage";
import { serviceEnv, serviceHeaders } from "./model/serviceBridge";
import { stageSourceHash, stageSourceProblem } from "./model/stageSource";
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
  viaPullRequest: v.boolean(),
});

const applyResultValidator = v.object({
  revision: v.number(),
  manifestHash: v.string(),
  durationMs: v.number(),
  phases: v.record(v.string(), v.number()),
});

const applyRunAnswer = z.object({
  ok: z.boolean(),
  output: z.string(),
  phases: z.record(z.string(), z.number()),
});

type ApplyResult = Infer<typeof applyResultValidator>;
type DockSession = Infer<typeof sessionValidator>;
type RepoTarget = Infer<typeof repoTargetValidator>;

// The dock talks to one Broods agent per deployment, as the signed-in user; null keeps its planner.
export const session = mutation({
  args: {},
  returns: v.union(sessionValidator, v.null()),
  handler: async (ctx): Promise<DockSession | null> => {
    const authUser = await authKit.getAuthUser(ctx);
    if (!authUser) throw new Error("User not found or not authenticated");
    const agent = dockAgent();
    if (!agent) return null;

    const expiresAt = Date.now() + USER_TOKEN_MAX_TTL_MS;
    const userToken = await sealUserToken(
      { userId: authUser.id, expiresAt: expiresAt },
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
      viaPullRequest: v.boolean(),
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
    viaPullRequest: boolean;
  } | null> => {
    const target = await repoTarget(ctx, args, false);
    if (!target) return null;
    const app = requireGitHubApp();
    const token = await installationToken(app, target.installationId);

    return {
      branch: target.branch,
      fullName: target.fullName,
      viaPullRequest: target.viaPullRequest,
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

// Applies the agent's edit as one commit; Production's branch gets a pull request instead.
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
      target.viaPullRequest,
      baseSha,
    );
  },
});

// The fast path: the approved files deploy from a compile sandbox with a ticket only this mints,
// then become the stage's source. The caller pushes them to a linked repo after.
export const apply = action({
  args: {
    projectId: v.id("projects"),
    stageId: v.id("stages"),
    baseRevision: v.union(v.number(), v.null()),
    files: v.array(repoFileValidator),
  },
  returns: applyResultValidator,
  handler: async (ctx, args): Promise<ApplyResult> => {
    const user = await authKit.getAuthUser(ctx);
    if (!user) throw new Error("User not found or not authenticated");
    const target = await ctx.runQuery(internal.agentDock.applyTarget, {
      authId: user.id,
      projectId: args.projectId,
      stageId: args.stageId,
    });
    if (!target) throw new ClientError("You cannot deploy this stage.");
    if (target.revision !== args.baseRevision)
      throw new ClientError(
        `The stage's source is now revision ${target.revision ?? "none"}. Review the new diff and apply again.`,
        "conflict",
      );
    const problem = stageSourceProblem(args.files);
    if (problem) throw new ClientError(`Cannot apply: ${problem}.`);
    const lock = args.files.find((file) => file.path === "bun.lock");
    const startedAt = Date.now();
    const service = serviceEnv();
    const response = await fetch(`${service.url}/v1/apply-runs`, {
      method: "POST",
      headers: serviceHeaders(target.accountId, service.secret),
      body: JSON.stringify({
        accountId: target.accountId,
        projectId: args.projectId,
        stageId: args.stageId,
        project: target.project,
        stage: target.stage,
        ticket: await sealApplyTicket(
          {
            accountId: target.accountId,
            projectId: args.projectId,
            stageId: args.stageId,
            authId: user.id,
          },
          stageTicketSecret(),
        ),
        lockHash: await stageSourceHash(lock ? [lock] : []),
        files: args.files,
      }),
    });
    const run = applyRunAnswer.safeParse(await response.json());
    if (!response.ok || !run.success)
      throw new Error(`Apply run failed with status ${response.status}`);
    if (!run.data.ok)
      throw new ClientError(`The deploy failed:\n${run.data.output}`);
    const manifestHash = await ctx.runQuery(internal.stageSources.syncedSince, {
      stageId: args.stageId,
      since: startedAt,
    });
    if (!manifestHash)
      throw new ClientError("The deploy finished without syncing the stage.");
    const revision = await storeStageSync(
      ctx,
      args.stageId,
      manifestHash,
      { files: args.files },
      "apply",
    );

    return {
      revision: revision ?? 0,
      manifestHash: manifestHash,
      durationMs: Date.now() - startedAt,
      phases: run.data.phases,
    };
  },
});

export const applyTarget = internalQuery({
  args: {
    authId: v.string(),
    projectId: v.id("projects"),
    stageId: v.id("stages"),
  },
  returns: v.union(
    v.object({
      accountId: v.string(),
      project: v.string(),
      stage: v.string(),
      revision: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  handler: async (
    ctx,
    { authId, projectId, stageId },
  ): Promise<{
    accountId: string;
    project: string;
    stage: string;
    revision: number | null;
  } | null> => {
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
    const production = stage.kind === "production";
    const branch = production ? repo.productionBranch : repo.developmentBranch;
    if (!branch) return null;

    return {
      branch: branch,
      fullName: repo.fullName,
      installationId: repo.installationId,
      rootDirectory: repo.rootDirectory,
      viaPullRequest: production,
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
