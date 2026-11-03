import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalQuery,
  mutation,
  type ActionCtx,
} from "./_generated/server";
import { authKit } from "./auth";
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

const repoTargetValidator = v.object({
  branch: v.string(),
  fullName: v.string(),
  installationId: v.number(),
  rootDirectory: v.string(),
  viaPullRequest: v.boolean(),
});

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

// Applies the agent's edit as one commit; Production's branch gets a pull request instead.
export const commitChange = action({
  args: {
    baseSha: v.string(),
    branch: v.string(),
    files: v.array(repoFileValidator),
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
