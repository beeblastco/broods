/**
 * Stage listing and creation for the `broods stage` commands, plus their HTTP
 * endpoint.
 *
 * Creation reuses the dashboard's `duplicateStageContents`, so a cloned
 * stage carries the same agent configs, MCP servers, canvas layout and
 * environment variables the dashboard duplicate button produces.
 *
 * Stage management spans every stage of a project, so the HTTP endpoint
 * authenticates with a `broods login` token rather than a stage-scoped
 * deploy key.
 */

import { v } from "convex/values";
import {
  httpAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "../model/accountSecrets";
import { duplicateStageContents, stageKindForName } from "../stage";
import { stageNameEquals, resolveProject } from "../model/projectScope";

const CANONICAL_NAMES = {
  development: "Development",
  production: "Production",
} as const;

const stageValidator = v.object({
  id: v.id("stages"),
  name: v.string(),
  kind: v.union(
    v.literal("development"),
    v.literal("production"),
    v.literal("custom"),
  ),
  isDefault: v.boolean(),
  deploymentRegion: v.optional(
    v.union(
      v.literal("ap-southeast-1"),
      v.literal("eu-west-1"),
      v.literal("us-east-1"),
    ),
  ),
  agentCount: v.number(),
  variableCount: v.number(),
  updatedAt: v.number(),
});

export const createByAccount = internalMutation({
  args: {
    accountId: v.id("accounts"),
    project: v.string(),
    name: v.string(),
    duplicateFrom: v.optional(v.string()),
  },
  returns: v.union(
    v.null(),
    v.object({
      stage: stageValidator,
      clonedFrom: v.union(v.null(), v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const projectDoc = await projectForAccount(
      ctx,
      args.accountId,
      args.project,
    );
    if (!projectDoc) return null;

    const trimmed = args.name.trim();
    if (!trimmed) throw new Error("Stage name is required");

    const stages = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectDoc._id))
      .collect();
    const kind = stageKindForName({ name: trimmed, kind: undefined });
    const displayName = kind === "custom" ? trimmed : CANONICAL_NAMES[kind];
    if (stages.some((entry) => stageNameEquals(entry.name, displayName))) {
      throw new Error(`Stage ${displayName} already exists`);
    }

    const source = args.duplicateFrom
      ? stages.find((entry) =>
          stageNameEquals(entry.name, args.duplicateFrom ?? ""),
        )
      : undefined;
    if (args.duplicateFrom && !source) {
      throw new Error(`Source stage ${args.duplicateFrom} was not found`);
    }

    // A brand-new stage is never the default; `cliSync.ensureStage`
    // repairs the Development-is-default invariant on the next sync.
    const now = Date.now();
    const stageId = await ctx.db.insert("stages", {
      authId: projectDoc.authId,
      projectId: projectDoc._id,
      name: displayName,
      kind: kind,
      isDefault: false,
      updatedAt: now,
    });
    if (source) {
      await duplicateStageContents(
        ctx,
        projectDoc.authId,
        projectDoc._id,
        source._id,
        stageId,
        now,
      );
    }
    await ctx.db.patch(projectDoc._id, { updatedAt: now });

    const created = await ctx.db.get(stageId);
    if (!created) throw new Error("Stage was not created");

    return {
      stage: await summarize(ctx, projectDoc._id, created),
      clonedFrom: source?.name ?? null,
    };
  },
});

/** HTTP endpoint for `broods stage list` and `broods stage create`. */
export const httpHandle = httpAction(async (ctx, req) => {
  try {
    const auth = await bearerAuth(req);
    if (!auth) {
      return json({ error: "Authorization Bearer token is required" }, 401);
    }

    const resolved = await ctx.runMutation(internal.cli.auth.resolveCliToken, {
      tokenHash: auth.secretHash,
    });
    if (!resolved) {
      return json(
        { error: "Stage commands require a `broods login` token" },
        401,
      );
    }

    if (req.method === "GET") {
      const project = new URL(req.url).searchParams.get("project") ?? "";
      if (!project.trim()) {
        return json({ error: "A project query parameter is required" }, 400);
      }
      const stages = await ctx.runQuery(internal.cli.stages.listByAccount, {
        accountId: resolved.accountId,
        project: project,
      });

      return stages
        ? json({ stages: stages })
        : json({ error: `Project ${project} was not found` }, 404);
    }

    if (req.method === "POST") {
      const body = (await req.json()) as {
        project?: unknown;
        name?: unknown;
        from?: unknown;
      };
      if (typeof body.project !== "string" || !body.project.trim()) {
        return json({ error: "Request body must include a project" }, 400);
      }
      if (typeof body.name !== "string" || !body.name.trim()) {
        return json({ error: "Request body must include a name" }, 400);
      }
      if (body.from !== undefined && typeof body.from !== "string") {
        return json({ error: "`from` must be a stage name" }, 400);
      }
      const created = await ctx.runMutation(
        internal.cli.stages.createByAccount,
        {
          accountId: resolved.accountId,
          project: body.project,
          name: body.name,
          ...(body.from ? { duplicateFrom: body.from } : {}),
        },
      );

      return created
        ? json(created)
        : json({ error: `Project ${body.project} was not found` }, 404);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    console.error("CLI stage request failed", error);
    if (error instanceof SyntaxError) {
      return json({ error: "Request body must be valid JSON" }, 400);
    }

    return json(
      {
        error: error instanceof Error ? error.message : "Stage request failed",
      },
      400,
    );
  }
});

export const listByAccount = internalQuery({
  args: {
    accountId: v.id("accounts"),
    project: v.string(),
  },
  returns: v.union(v.null(), v.array(stageValidator)),
  handler: async (ctx, args) => {
    const projectDoc = await projectForAccount(
      ctx,
      args.accountId,
      args.project,
    );
    if (!projectDoc) return null;

    const stageDocs = await ctx.db
      .query("stages")
      .withIndex("by_projectId", (q) => q.eq("projectId", projectDoc._id))
      .collect();
    const stages = [];
    for (const stage of stageDocs) {
      stages.push(await summarize(ctx, projectDoc._id, stage));
    }

    return stages.sort((a, b) =>
      a.isDefault !== b.isDefault
        ? a.isDefault
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
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

async function projectForAccount(
  ctx: MutationCtx | QueryCtx,
  accountId: Id<"accounts">,
  project: string,
): Promise<Doc<"projects"> | null> {
  const account = await ctx.db.get(accountId);
  if (!account || account.status !== "active") return null;

  return await resolveProject(ctx, account, project);
}

async function summarize(
  ctx: MutationCtx | QueryCtx,
  projectId: Id<"projects">,
  stage: Doc<"stages">,
): Promise<{
  id: Id<"stages">;
  name: string;
  kind: ReturnType<typeof stageKindForName>;
  isDefault: boolean;
  deploymentRegion?: Doc<"stages">["deploymentRegion"];
  agentCount: number;
  variableCount: number;
  updatedAt: number;
}> {
  const agents = await ctx.db
    .query("agentConfigs")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stage._id),
    )
    .collect();
  const variables = await ctx.db
    .query("environmentVariables")
    .withIndex("by_projectId_and_stageId", (q) =>
      q.eq("projectId", projectId).eq("stageId", stage._id),
    )
    .collect();

  return {
    id: stage._id,
    name: stage.name,
    kind: stageKindForName(stage),
    isDefault: stage.isDefault,
    ...(stage.deploymentRegion
      ? { deploymentRegion: stage.deploymentRegion }
      : {}),
    agentCount: agents.length,
    variableCount: variables.length,
    updatedAt: stage.updatedAt,
  };
}
