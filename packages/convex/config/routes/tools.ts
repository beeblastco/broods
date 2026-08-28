/**
 * Tools CRUD (`/v1/tools*`): list/create on the stage-scoped collection,
 * get/patch/delete by id. Bundle bytes go to S3 via awsBundles; metadata lives
 * in the accountTools table.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { normalizeAccountToolUpload } from "../../model/accountTools";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import { putToolBundle } from "../../model/bundles";
import type { ProjectStageScope } from "../../model/projectScope";
import { json, methodNotAllowed, writeAudit } from "./shared";

type ToolScope =
  ({ ok: true } & ProjectStageScope) | { ok: false; response: Response };

/**
 * Tools CRUD: list/create on the collection, get/patch/delete by id. Bundle
 * bytes go to S3 via awsBundles; metadata lives in the accountTools table.
 * Mirrors core's former handleToolRoute contract.
 */
export async function handleToolRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  toolId?: string,
): Promise<Response> {
  if (!toolId)
    return await handleToolCollectionRoute(ctx, req, accountId, actor);

  if (req.method === "GET") {
    const record = await ctx.runQuery(internal.account.tools.getById, {
      accountId: accountId,
      toolId: toolId,
    });

    return isAddressableTool(record)
      ? json(toPublicAccountTool(record))
      : json({ error: "Tool not found" }, 404);
  }
  if (req.method === "PATCH") {
    return await patchToolRoute(ctx, req, accountId, actor, toolId);
  }
  if (req.method === "DELETE") {
    const existing = await ctx.runQuery(internal.account.tools.getById, {
      accountId: accountId,
      toolId: toolId,
    });
    if (!isAddressableTool(existing))
      return json({ error: "Tool not found" }, 404);
    await ctx.runMutation(internal.account.tools.remove, {
      accountId: accountId,
      toolId: toolId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "deleted",
      resource: { kind: "tool", id: existing._id, name: existing.name },
      summary: "Tool deleted",
      detailsJson: auditDetailsJson({ toolId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/** Collection verbs: list the stage's tools on GET, upload and create on POST. */
async function handleToolCollectionRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
): Promise<Response> {
  // Tools belong to one stage, so the collection routes need a scope.
  const scope = await resolveToolScope(ctx, req, accountId);
  if (!scope.ok) return scope.response;

  if (req.method === "GET") {
    const records = await ctx.runQuery(internal.account.tools.listForStage, {
      stageId: scope.stageId,
    });

    return json({
      tools: records.map((record) => toPublicAccountTool(record)),
    });
  }
  if (req.method === "POST") {
    const upload = await normalizeAccountToolUpload(await req.json(), {
      requireBundle: true,
    });
    const bundleStorageKey = await putToolBundle(ctx, {
      accountId: accountId,
      sha256: upload.sha256,
      bundle: upload.bundle,
    });
    const createdId = await ctx.runMutation(internal.account.tools.create, {
      accountId: accountId,
      projectId: scope.projectId,
      stageId: scope.stageId,
      name: upload.name,
      description: upload.description,
      inputSchema: upload.inputSchema,
      bundleStorageKey: bundleStorageKey,
      sha256: upload.sha256,
      runtime: upload.runtime,
      ...(upload.defaultConfig !== undefined
        ? { defaultConfig: upload.defaultConfig }
        : {}),
    });
    const created = await ctx.runQuery(internal.account.tools.getById, {
      accountId: accountId,
      toolId: createdId,
    });
    if (created) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "created",
        resource: { kind: "tool", id: created._id, name: created.name },
        summary: "Tool created",
        detailsJson: auditDetailsJson({
          toolId: created._id,
          sha256: created.sha256,
        }),
      });
    }

    return json(toPublicAccountTool(created!), 201);
  }

  return methodNotAllowed(["GET", "POST"]);
}

// The scoped API only addresses scoped rows: an unscoped legacy row is a
// migration-cleanup candidate, and serializing it would drop the scope fields
// the SDK and the OpenAPI schema both declare required.
function isAddressableTool(
  record: Doc<"accountTools"> | null,
): record is Doc<"accountTools"> {
  return Boolean(
    record && record.status === "active" && record.projectId && record.stageId,
  );
}

/** PATCH one tool: optional re-upload of the bundle plus metadata updates. */
async function patchToolRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  toolId: string,
): Promise<Response> {
  const existing = await ctx.runQuery(internal.account.tools.getById, {
    accountId: accountId,
    toolId: toolId,
  });
  if (!isAddressableTool(existing))
    return json({ error: "Tool not found" }, 404);
  const upload = await normalizeAccountToolUpload(await req.json(), {
    requireBundle: false,
    currentRuntime: existing.runtime,
  });
  const bundleStorageKey =
    upload.bundle !== undefined && upload.sha256 !== undefined
      ? await putToolBundle(ctx, {
          accountId: accountId,
          sha256: upload.sha256,
          bundle: upload.bundle,
        })
      : undefined;
  await ctx.runMutation(internal.account.tools.update, {
    accountId: accountId,
    toolId: toolId,
    ...(upload.name !== undefined ? { name: upload.name } : {}),
    ...(upload.description !== undefined
      ? { description: upload.description }
      : {}),
    ...(upload.inputSchema !== undefined
      ? { inputSchema: upload.inputSchema }
      : {}),
    ...(bundleStorageKey !== undefined
      ? { bundleStorageKey: bundleStorageKey, sha256: upload.sha256 }
      : {}),
    ...(upload.runtime !== undefined ? { runtime: upload.runtime } : {}),
    ...(upload.defaultConfig !== undefined
      ? { defaultConfig: upload.defaultConfig }
      : {}),
  });
  const updated = await ctx.runQuery(internal.account.tools.getById, {
    accountId: accountId,
    toolId: toolId,
  });
  if (updated) {
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "tool", id: updated._id, name: updated.name },
      summary: "Tool updated",
      detailsJson: auditDetailsJson({
        toolId: updated._id,
        sha256: updated.sha256,
      }),
    });
  }

  return updated
    ? json(toPublicAccountTool(updated))
    : json({ error: "Tool not found" }, 404);
}

/** Resolve the `?project=&stage=` collection scope to project/stage ids. */
async function resolveToolScope(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
): Promise<ToolScope> {
  const params = new URL(req.url).searchParams;
  const project = params.get("project")?.trim();
  const stage = params.get("stage")?.trim();
  if (!project || !stage) {
    return {
      ok: false,
      response: json(
        {
          error:
            "Tools are scoped to a stage: pass ?project=<slug>&stage=<name>",
        },
        400,
      ),
    };
  }

  const scope = await ctx.runQuery(internal.account.tools.resolveScope, {
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

/**
 * Map an accountTools document to the public tool shape core used to return.
 * @param record the accountTools document
 * @returns the public record with toolId and ISO timestamps
 */
function toPublicAccountTool(
  record: Doc<"accountTools">,
): Record<string, unknown> {
  return {
    accountId: record.accountId,
    toolId: record._id,
    projectId: record.projectId,
    stageId: record.stageId,
    name: record.name,
    description: record.description,
    inputSchema: record.inputSchema,
    sha256: record.sha256,
    runtime: record.runtime ?? "sandbox",
    ...(record.defaultConfig !== undefined
      ? { defaultConfig: record.defaultConfig }
      : {}),
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    ...(record.deletedAt
      ? { deletedAt: new Date(record.deletedAt).toISOString() }
      : {}),
  };
}
