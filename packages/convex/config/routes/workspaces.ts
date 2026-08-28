/**
 * Workspace config CRUD (`/v1/workspaces*`): list/create on the collection,
 * get/patch/delete by id. Deletes purge managed files and tear down reserved
 * sandboxes bound to the workspace namespace.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import { toPublicWorkspaceConfigResponse } from "../../model/responses";
import {
  normalizeCreateWorkspaceConfigInput,
  normalizeUpdateWorkspaceConfigInput,
  workspaceNamespace,
} from "../../model/workspaceRules";
import {
  json,
  methodNotAllowed,
  terminateReservedInstances,
  writeAudit,
} from "./shared";

/**
 * Workspace config CRUD: list/create on the collection, get/patch/delete by id.
 * Mirrors core's former handleWorkspaceRoute contract.
 */
export async function handleWorkspaceConfigRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  workspaceId?: string,
): Promise<Response> {
  if (!workspaceId) {
    if (req.method === "GET") {
      const records: Doc<"workspaceConfigs">[] = await ctx.runQuery(
        internal.workspace.configs.list,
        { accountId: accountId },
      );

      return json({
        workspaces: records.map((record) =>
          toPublicWorkspaceConfigResponse(record),
        ),
      });
    }
    if (req.method === "POST") {
      const input = normalizeCreateWorkspaceConfigInput(await req.json());
      const createdId: Id<"workspaceConfigs"> = await ctx.runMutation(
        internal.workspace.configs.create,
        {
          accountId: accountId,
          name: input.name,
          description: input.description,
          config: input.config,
        },
      );
      const created: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
        internal.workspace.configs.getById,
        {
          accountId: accountId,
          workspaceId: createdId,
        },
      );
      if (!created) throw new Error("Failed to fetch created workspace config");
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        stageId: created.stageId,
        actor: actor,
        action: "created",
        resource: { kind: "workspace", id: created._id, name: created.name },
        summary: "Workspace created",
        detailsJson: auditDetailsJson({ workspaceId: created._id }),
      });

      return json(toPublicWorkspaceConfigResponse(created), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspace.configs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );

    return record
      ? json(toPublicWorkspaceConfigResponse(record))
      : json({ error: "Workspace not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspace.configs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );
    if (!existing) return json({ error: "Workspace not found" }, 404);
    const patch = normalizeUpdateWorkspaceConfigInput(
      existing.config ?? { storage: { provider: "s3" } },
      await req.json(),
    );
    await ctx.runMutation(internal.workspace.configs.update, {
      accountId: accountId,
      workspaceId: workspaceId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description ?? undefined }
        : {}),
      config: patch.config,
    });
    const updated: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspace.configs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        stageId: updated.stageId,
        actor: actor,
        action: "updated",
        resource: { kind: "workspace", id: updated._id, name: updated.name },
        summary: "Workspace updated",
        detailsJson: auditDetailsJson({ workspaceId: updated._id }),
      });
    }

    return updated
      ? json(toPublicWorkspaceConfigResponse(updated))
      : json({ error: "Workspace not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"workspaceConfigs"> | null = await ctx.runQuery(
      internal.workspace.configs.getById,
      {
        accountId: accountId,
        workspaceId: workspaceId,
      },
    );
    if (!existing) return json({ error: "Workspace not found" }, 404);
    if (!existing.config?.storage?.bucket) {
      // Only purge managed workspace files; bring-your-own buckets are
      // customer-owned. A purge failure fails the DELETE (matching core)
      // so the record is never removed while its files linger.
      await ctx.runAction(internal.aws.workspaceFiles.purge, {
        accountId: accountId,
        workspaceId: existing._id,
      });
    }
    // Tear down any reserved sandbox bound to this workspace's namespace
    // (reservation keys are the namespace or namespace-prefixed).
    const namespace = await workspaceNamespace(accountId, existing._id);
    await terminateReservedInstances(
      ctx,
      accountId,
      (instance) =>
        instance.reservationKey === namespace ||
        instance.reservationKey.startsWith(`${namespace}/`),
    ).catch(() => undefined);
    await ctx.runMutation(internal.workspace.configs.remove, {
      accountId: accountId,
      workspaceId: workspaceId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      stageId: existing.stageId,
      actor: actor,
      action: "deleted",
      resource: { kind: "workspace", id: existing._id, name: existing.name },
      summary: "Workspace deleted",
      detailsJson: auditDetailsJson({ workspaceId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}
