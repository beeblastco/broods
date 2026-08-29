/**
 * MCP server CRUD (`/v1/mcp*`): list/create on the stage-scoped
 * collection, get/patch/delete by id. No bundle path — phase 1 rows describe
 * an external server core connects to; secrets stay in account env vars as
 * ${NAME} refs on the header values.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import { normalizeMcpInput } from "../../model/mcp";
import type { ProjectStageScope } from "../../model/projectScope";
import { json, methodNotAllowed, writeAudit } from "./shared";

type McpScope =
  | ({ ok: true } & ProjectStageScope)
  | { ok: false; response: Response };

/** MCP server CRUD: list/create on the collection, get/patch/delete by id. */
export async function handleMcpRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  serverId?: string,
): Promise<Response> {
  if (!serverId)
    return await handleMcpCollectionRoute(ctx, req, accountId, actor);

  if (req.method === "GET") {
    const record = await ctx.runQuery(internal.account.mcp.getById, {
      accountId: accountId,
      serverId: serverId,
    });

    return record
      ? json(toPublicMcp(record))
      : json({ error: "MCP server not found" }, 404);
  }
  if (req.method === "PATCH") {
    return await patchMcpRoute(ctx, req, accountId, actor, serverId);
  }
  if (req.method === "DELETE") {
    const existing = await ctx.runQuery(internal.account.mcp.getById, {
      accountId: accountId,
      serverId: serverId,
    });
    if (!existing) return json({ error: "MCP server not found" }, 404);
    await ctx.runMutation(internal.account.mcp.remove, {
      accountId: accountId,
      serverId: serverId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      stageId: existing.stageId,
      actor: actor,
      action: "deleted",
      resource: { kind: "mcp", id: existing._id, name: existing.name },
      summary: "MCP server deleted",
      detailsJson: auditDetailsJson({ serverId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/** Collection verbs: list the stage's servers on GET, register on POST. */
async function handleMcpCollectionRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
): Promise<Response> {
  // Servers belong to one stage, so the collection routes need a scope.
  const scope = await resolveMcpScope(ctx, req, accountId);
  if (!scope.ok) return scope.response;

  if (req.method === "GET") {
    const records = await ctx.runQuery(internal.account.mcp.listForStage, {
      stageId: scope.stageId,
    });

    return json({
      servers: records.map((record) => toPublicMcp(record)),
    });
  }
  if (req.method === "POST") {
    const input = normalizeMcpInput(await req.json(), {
      requireConnection: true,
    });
    const createdId = await ctx.runMutation(internal.account.mcp.create, {
      accountId: accountId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      name: input.name!,
      url: input.url!,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.headers !== undefined ? { headers: input.headers } : {}),
      ...(input.allowedTools !== undefined
        ? { allowedTools: input.allowedTools }
        : {}),
    });
    const created = await ctx.runQuery(internal.account.mcp.getById, {
      accountId: accountId,
      serverId: createdId,
    });
    if (created) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        stageId: created.stageId,
        actor: actor,
        action: "created",
        resource: { kind: "mcp", id: created._id, name: created.name },
        summary: "MCP server registered",
        detailsJson: auditDetailsJson({
          serverId: created._id,
          url: created.url,
        }),
      });
    }

    return json(toPublicMcp(created!), 201);
  }

  return methodNotAllowed(["GET", "POST"]);
}

/** PATCH one server: any subset of the registration fields. */
async function patchMcpRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  serverId: string,
): Promise<Response> {
  const existing = await ctx.runQuery(internal.account.mcp.getById, {
    accountId: accountId,
    serverId: serverId,
  });
  if (!existing) return json({ error: "MCP server not found" }, 404);
  const input = normalizeMcpInput(await req.json(), {
    requireConnection: false,
  });
  await ctx.runMutation(internal.account.mcp.update, {
    accountId: accountId,
    serverId: serverId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    ...(input.allowedTools !== undefined
      ? { allowedTools: input.allowedTools }
      : {}),
    ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
  });
  const updated = await ctx.runQuery(internal.account.mcp.getById, {
    accountId: accountId,
    serverId: serverId,
  });
  if (updated) {
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: updated.projectId,
      stageId: updated.stageId,
      actor: actor,
      action: "updated",
      resource: { kind: "mcp", id: updated._id, name: updated.name },
      summary: "MCP server updated",
      detailsJson: auditDetailsJson({
        serverId: updated._id,
        url: updated.url,
      }),
    });
  }

  return updated
    ? json(toPublicMcp(updated))
    : json({ error: "MCP server not found" }, 404);
}

/** Resolve the `?project=&stage=` collection scope to project/stage ids. */
async function resolveMcpScope(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
): Promise<McpScope> {
  const params = new URL(req.url).searchParams;
  const project = params.get("project")?.trim();
  const stage = params.get("stage")?.trim();
  if (!project || !stage) {
    return {
      ok: false,
      response: json(
        {
          error:
            "MCP servers are scoped to a stage: pass ?project=<slug>&stage=<name>",
        },
        400,
      ),
    };
  }

  const scope = await ctx.runQuery(internal.account.mcp.resolveScope, {
    accountId: accountId,
    project: project,
    stage: stage,
  });
  if (!scope) {
    return {
      ok: false,
      response: json({ error: "Project or stage not found" }, 404),
    };
  }

  return {
    ok: true,
    projectId: scope.projectId,
    stageId: scope.stageId,
  };
}

/** Map an mcp document to its public API shape. */
function toPublicMcp(record: Doc<"mcp">): Record<string, unknown> {
  return {
    accountId: record.accountId,
    serverId: record._id,
    projectId: record.projectId,
    stageId: record.stageId,
    name: record.name,
    ...(record.description !== undefined
      ? { description: record.description }
      : {}),
    transport: record.transport,
    url: record.url,
    ...(record.headers !== undefined ? { headers: record.headers } : {}),
    ...(record.allowedTools !== undefined
      ? { allowedTools: record.allowedTools }
      : {}),
    disabled: record.disabled ?? false,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    ...(record.deletedAt
      ? { deletedAt: new Date(record.deletedAt).toISOString() }
      : {}),
  };
}
