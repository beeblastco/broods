/**
 * Project listing and deletion for the `broods project` commands, plus the
 * HTTP endpoints for project management and CLI onboarding (org/project
 * selection, which bootstraps projects and stages).
 *
 * Deletion reuses the dashboard's `purgeProject`, so a project removed from the
 * CLI leaves exactly what the dashboard's danger panel leaves: no stages, no
 * agent configs, no canvas, no env vars, no crons, no workspace files or blobs.
 *
 * Project management spans every stage of a project, so the HTTP endpoints
 * authenticate with a `broods login` token rather than a stage-scoped deploy
 * key, exactly as the stage endpoint does.
 */

import { v } from "convex/values";
import {
  httpAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { sha256Hex } from "./model/accountSecrets";
import { purgeProject } from "./model/cascade";
import { getProjectForRole } from "./model/ownership/project";

// Counts stop at this many rows per table so an org full of large projects
// cannot push `listByAccount` past Convex's per-transaction read limits. A
// capped count still reads correctly: it only ever understates a project that
// is far too full to be a cleanup target anyway.
const COUNT_LIMIT = 1000;

const projectValidator = v.object({
  id: v.id("projects"),
  name: v.string(),
  slug: v.string(),
  /** No stage, agent, variable, deployment or workspace file: safe to delete without reading further. */
  empty: v.boolean(),
  stageCount: v.number(),
  agentCount: v.number(),
  variableCount: v.number(),
  deploymentCount: v.number(),
  fileCount: v.number(),
  updatedAt: v.number(),
});

/** HTTP endpoint for `broods project list` and `broods project delete`. */
export const httpHandle = httpAction(async (ctx, req) => {
  try {
    const auth = await bearerAuth(req);
    if (!auth) {
      return json({ error: "Authorization Bearer token is required" }, 401);
    }

    const resolved = await ctx.runMutation(internal.cliAuth.resolveCliToken, {
      tokenHash: auth.secretHash,
    });
    if (!resolved) {
      return json(
        { error: "Project commands require a `broods login` token" },
        401,
      );
    }

    if (req.method === "GET") {
      const projects = await ctx.runQuery(internal.cliProjects.listByAccount, {
        accountId: resolved.accountId,
      });

      return projects
        ? json({ projects: projects })
        : json({ error: "Account is not active" }, 403);
    }

    if (req.method === "DELETE") {
      const projectId =
        new URL(req.url).searchParams.get("projectId")?.trim() ?? "";
      if (!projectId) {
        return json({ error: "A projectId query parameter is required" }, 400);
      }
      const deleted = await ctx.runMutation(
        internal.cliProjects.removeByAccount,
        {
          accountId: resolved.accountId,
          authId: resolved.authId,
          projectId: projectId,
        },
      );
      if (deleted === "forbidden") {
        return json(
          { error: "Deleting a project requires an org admin role" },
          403,
        );
      }

      return deleted
        ? json({ deleted: deleted })
        : json({ error: "Project was not found" }, 404);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("CLI project request failed", error);
    if (error instanceof SyntaxError || error instanceof URIError) {
      return json({ error: "Request body or path is invalid" }, 400);
    }
    const detail = error instanceof Error ? error.message : "";

    return json(
      {
        error: "Project request failed",
        ...(detail ? { detail: detail } : {}),
      },
      500,
    );
  }
});

/** HTTP onboarding endpoint for CLI project/org selection. */
export const httpOnboarding = httpAction(async (ctx, req) => {
  try {
    const auth = await bearerAuth(req);
    if (!auth) {
      return json({ error: "Authorization Bearer token is required" }, 401);
    }

    if (req.method === "GET") {
      const context = await ctx.runMutation(
        internal.cliAuth.getOnboardingContext,
        {
          tokenHash: auth.secretHash,
        },
      );
      if (!context) return json({ error: "Invalid CLI token" }, 401);

      return json(context);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as {
        orgId?: unknown;
        createOrgName?: unknown;
      };
      if (typeof body.createOrgName === "string" && body.createOrgName.trim()) {
        const context = await ctx.runMutation(
          internal.cliAuth.createOnboardingOrg,
          {
            tokenHash: auth.secretHash,
            name: body.createOrgName,
          },
        );
        if (!context) return json({ error: "Invalid CLI token" }, 401);

        return json(context);
      }
      if (typeof body.orgId !== "string" || !body.orgId.trim()) {
        return json(
          { error: "Request body must include orgId or createOrgName" },
          400,
        );
      }
      const context = await ctx.runMutation(
        internal.cliAuth.selectOnboardingOrg,
        {
          tokenHash: auth.secretHash,
          orgId: body.orgId as Id<"orgs">,
        },
      );
      if (!context) return json({ error: "Invalid CLI token" }, 401);

      return json(context);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("CLI onboarding request failed", error);
    if (error instanceof SyntaxError) {
      return json({ error: "Request body must be valid JSON" }, 400);
    }

    return json({ error: "Onboarding request failed" }, 500);
  }
});

/**
 * Every project in the account's org, each with the counts that say whether it
 * still holds anything. Sorted empty-last so a cleanup pass reads top-down.
 */
export const listByAccount = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.union(v.null(), v.array(projectValidator)),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status !== "active") return null;
    const orgId = ctx.db.normalizeId("orgs", account.orgId);
    if (!orgId) return null;

    const projectDocs = await ctx.db
      .query("projects")
      .withIndex("by_orgId", (q) => q.eq("orgId", orgId))
      .collect();
    const projects = [];
    for (const project of projectDocs) {
      projects.push(await summarize(ctx, project));
    }

    return projects.sort((left, right) =>
      left.empty !== right.empty
        ? left.empty
          ? 1
          : -1
        : left.name.localeCompare(right.name),
    );
  },
});

/**
 * Delete one project of the account's org and everything under it.
 *
 * Takes the project id, never a name: names are not unique, and resolving one
 * here could purge a different project than the one the CLI showed the user.
 * Deletion re-checks the caller's org role the way the dashboard's
 * `project.remove` does, so a token minted by a since-demoted admin answers
 * "forbidden" rather than deleting.
 *
 * Returns null when the id matches no project of the account's org, so the
 * caller can answer 404 rather than reporting a deletion that never happened.
 * The counts come from before the purge; they are what the CLI prints back.
 */
export const removeByAccount = internalMutation({
  args: {
    accountId: v.id("accounts"),
    authId: v.string(),
    projectId: v.string(),
  },
  returns: v.union(v.null(), v.literal("forbidden"), projectValidator),
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId);
    if (!account || account.status !== "active") return null;
    const orgId = ctx.db.normalizeId("orgs", account.orgId);
    if (!orgId) return null;

    const projectId = ctx.db.normalizeId("projects", args.projectId);
    if (!projectId) return null;
    const projectDoc = await ctx.db.get(projectId);
    if (!projectDoc || projectDoc.orgId !== orgId) return null;

    const authorized = await getProjectForRole(
      ctx,
      args.authId,
      projectId,
      "admin",
    );
    if (!authorized) return "forbidden";

    const summary = await summarize(ctx, projectDoc);
    await purgeProject(ctx, projectId);

    return summary;
  },
});

async function bearerAuth(
  req: Request,
): Promise<{ secretHash: string } | null> {
  const header = req.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }

  return {
    secretHash: await sha256Hex(match[1]),
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json" },
  });
}

async function summarize(
  ctx: MutationCtx | QueryCtx,
  project: Doc<"projects">,
): Promise<{
  id: Id<"projects">;
  name: string;
  slug: string;
  empty: boolean;
  stageCount: number;
  agentCount: number;
  variableCount: number;
  deploymentCount: number;
  fileCount: number;
  updatedAt: number;
}> {
  const stages = await ctx.db
    .query("stages")
    .withIndex("by_projectId", (q) => q.eq("projectId", project._id))
    .take(COUNT_LIMIT);
  const agents = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", project._id),
    )
    .take(COUNT_LIMIT);
  const variables = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", project._id),
    )
    .take(COUNT_LIMIT);
  const deployments = await ctx.db
    .query("agentDeployments")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", project._id),
    )
    .take(COUNT_LIMIT);
  const files = await ctx.db
    .query("workspaceFiles")
    .withIndex("by_projectId_and_nodeId", (q) => q.eq("projectId", project._id))
    .take(COUNT_LIMIT);

  return {
    id: project._id,
    name: project.name,
    slug: project.slug,
    empty:
      stages.length === 0 &&
      agents.length === 0 &&
      variables.length === 0 &&
      deployments.length === 0 &&
      files.length === 0,
    stageCount: stages.length,
    agentCount: agents.length,
    variableCount: variables.length,
    deploymentCount: deployments.length,
    fileCount: files.length,
    updatedAt: project.updatedAt,
  };
}
