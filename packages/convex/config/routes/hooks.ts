/**
 * Hooks CRUD (`/v1/hooks*`): list/create on the collection, get/patch/delete
 * by id. Bundle bytes go to S3 via awsBundles; metadata lives in the
 * accountHooks table.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { normalizeAccountHookUpload } from "../../model/accountHooks";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import { putHookBundle } from "../../model/bundles";
import { json, methodNotAllowed, writeAudit } from "./shared";

/**
 * Hooks CRUD: list/create on the collection, get/patch/delete by id. Bundle
 * bytes go to S3 via awsBundles; metadata lives in the accountHooks table.
 */
export async function handleHookRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  hookId?: string,
): Promise<Response> {
  if (!hookId)
    return await handleHookCollectionRoute(ctx, req, accountId, actor);

  if (req.method === "GET") {
    const record = await ctx.runQuery(internal.account.hooks.getById, {
      accountId: accountId,
      hookId: hookId,
    });

    return record && record.status === "active"
      ? json(toPublicAccountHook(record))
      : json({ error: "Hook not found" }, 404);
  }
  if (req.method === "PATCH") {
    return await patchHookRoute(ctx, req, accountId, actor, hookId);
  }
  if (req.method === "DELETE") {
    const existing = await ctx.runQuery(internal.account.hooks.getById, {
      accountId: accountId,
      hookId: hookId,
    });
    if (!existing || existing.status !== "active")
      return json({ error: "Hook not found" }, 404);
    await ctx.runMutation(internal.account.hooks.remove, {
      accountId: accountId,
      hookId: hookId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "deleted",
      resource: { kind: "hook", id: existing._id, name: existing.name },
      summary: "Hook deleted",
      detailsJson: auditDetailsJson({ hookId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/** Collection verbs: list hooks on GET, upload and create on POST. */
async function handleHookCollectionRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
): Promise<Response> {
  if (req.method === "GET") {
    const records = await ctx.runQuery(internal.account.hooks.list, {
      accountId: accountId,
    });

    return json({
      hooks: records.map((record) => toPublicAccountHook(record)),
    });
  }
  if (req.method === "POST") {
    const upload = await normalizeAccountHookUpload(await req.json(), {
      requireBundle: true,
    });
    const bundleStorageKey = await putHookBundle(ctx, {
      accountId: accountId,
      sha256: upload.sha256,
      bundle: upload.bundle,
    });
    const createdId = await ctx.runMutation(internal.account.hooks.create, {
      accountId: accountId,
      name: upload.name,
      ...(upload.description !== undefined
        ? { description: upload.description }
        : {}),
      events: upload.events,
      bundleStorageKey: bundleStorageKey,
      sha256: upload.sha256,
    });
    const created = await ctx.runQuery(internal.account.hooks.getById, {
      accountId: accountId,
      hookId: createdId,
    });
    if (created) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "created",
        resource: { kind: "hook", id: created._id, name: created.name },
        summary: "Hook created",
        detailsJson: auditDetailsJson({
          hookId: created._id,
          sha256: created.sha256,
        }),
      });
    }

    return json(toPublicAccountHook(created!), 201);
  }

  return methodNotAllowed(["GET", "POST"]);
}

/** PATCH one hook: optional bundle replacement (skipped when sha matches) plus metadata. */
async function patchHookRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  hookId: string,
): Promise<Response> {
  const existing = await ctx.runQuery(internal.account.hooks.getById, {
    accountId: accountId,
    hookId: hookId,
  });
  if (!existing || existing.status !== "active")
    return json({ error: "Hook not found" }, 404);
  const upload = await normalizeAccountHookUpload(await req.json(), {
    requireBundle: false,
  });
  // Skip the S3 round-trip when the uploaded bundle matches what the hook
  // already stores; the key is content-addressed by sha so nothing changes.
  const bundleStorageKey =
    upload.bundle !== undefined && upload.sha256 !== undefined
      ? upload.sha256 === existing.sha256
        ? existing.bundleStorageKey
        : await putHookBundle(ctx, {
            accountId: accountId,
            sha256: upload.sha256,
            bundle: upload.bundle,
          })
      : undefined;
  await ctx.runMutation(internal.account.hooks.update, {
    accountId: accountId,
    hookId: hookId,
    ...(upload.name !== undefined ? { name: upload.name } : {}),
    ...(upload.description !== undefined
      ? { description: upload.description }
      : {}),
    ...(upload.events !== undefined ? { events: upload.events } : {}),
    ...(bundleStorageKey !== undefined
      ? { bundleStorageKey: bundleStorageKey, sha256: upload.sha256 }
      : {}),
  });
  const updated = await ctx.runQuery(internal.account.hooks.getById, {
    accountId: accountId,
    hookId: hookId,
  });
  if (updated) {
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "hook", id: updated._id, name: updated.name },
      summary: "Hook updated",
      detailsJson: auditDetailsJson({
        hookId: updated._id,
        sha256: updated.sha256,
      }),
    });
  }

  return updated
    ? json(toPublicAccountHook(updated))
    : json({ error: "Hook not found" }, 404);
}

/**
 * Map an accountHooks document to the public hook shape.
 * @param record the accountHooks document
 * @returns the public record with hookId and ISO timestamps
 */
function toPublicAccountHook(
  record: Doc<"accountHooks">,
): Record<string, unknown> {
  return {
    accountId: record.accountId,
    hookId: record._id,
    name: record.name,
    ...(record.description !== undefined
      ? { description: record.description }
      : {}),
    events: record.events,
    sha256: record.sha256,
    status: record.status,
    createdAt: new Date(record.createdAt).toISOString(),
    updatedAt: new Date(record.updatedAt).toISOString(),
    ...(record.deletedAt
      ? { deletedAt: new Date(record.deletedAt).toISOString() }
      : {}),
  };
}
