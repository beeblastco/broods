/**
 * Channel record CRUD (`/v1/channels*`). A record binds one real chat channel
 * to an agent; the runtime reads it on the inbound webhook to decide who
 * answers there.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import {
  normalizeCreateChannelRecordInput,
  normalizeUpdateChannelRecordInput,
} from "../../model/channelRules";
import { toPublicChannelRecordResponse } from "../../model/responses";
import { json, methodNotAllowed, writeAudit } from "./shared";

// Channel records CRUD. A record binds one real chat channel to an agent; the
// runtime reads it on the inbound webhook to decide who answers there.
export async function handleChannelRecordRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  channelId?: string,
): Promise<Response> {
  if (!channelId) {
    if (req.method === "GET") {
      const records: Doc<"channelRecords">[] = await ctx.runQuery(
        internal.channel.records.listActive,
        { accountId: accountId },
      );

      return json({
        channels: records.map((record) =>
          toPublicChannelRecordResponse(record),
        ),
      });
    }
    if (req.method === "POST") {
      const input = normalizeCreateChannelRecordInput(await req.json());
      const createdId: Id<"channelRecords"> = await ctx.runMutation(
        internal.channel.records.create,
        {
          accountId: accountId,
          platform: input.platform,
          externalId: input.externalId,
          workspaceRef: input.workspaceRef,
          name: input.name,
          description: input.description,
          config: input.config,
        },
      );
      const created: Doc<"channelRecords"> | null = await ctx.runQuery(
        internal.channel.records.getById,
        { accountId: accountId, channelRecordId: createdId },
      );
      if (!created) throw new Error("Failed to fetch created channel record");
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: created.projectId,
        stageId: created.stageId,
        actor: actor,
        action: "created",
        resource: { kind: "channel", id: created._id, name: created.name },
        summary: "Channel created",
        detailsJson: auditDetailsJson({
          channelId: created._id,
          platform: created.platform,
        }),
      });

      return json(toPublicChannelRecordResponse(created), 201);
    }

    return methodNotAllowed(["GET", "POST"]);
  }

  if (req.method === "GET") {
    const record: Doc<"channelRecords"> | null = await ctx.runQuery(
      internal.channel.records.getById,
      { accountId: accountId, channelRecordId: channelId },
    );

    return record
      ? json(toPublicChannelRecordResponse(record))
      : json({ error: "Channel not found" }, 404);
  }
  if (req.method === "PATCH") {
    const existing: Doc<"channelRecords"> | null = await ctx.runQuery(
      internal.channel.records.getById,
      { accountId: accountId, channelRecordId: channelId },
    );
    if (!existing) return json({ error: "Channel not found" }, 404);
    const patch = normalizeUpdateChannelRecordInput(await req.json());
    await ctx.runMutation(internal.channel.records.update, {
      accountId: accountId,
      channelRecordId: channelId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined
        ? { description: patch.description }
        : {}),
      ...(patch.workspaceRef !== undefined
        ? { workspaceRef: patch.workspaceRef }
        : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    });
    const updated: Doc<"channelRecords"> | null = await ctx.runQuery(
      internal.channel.records.getById,
      { accountId: accountId, channelRecordId: channelId },
    );
    if (updated) {
      await writeAudit(ctx, {
        accountId: accountId,
        projectId: updated.projectId,
        stageId: updated.stageId,
        actor: actor,
        action: "updated",
        resource: { kind: "channel", id: updated._id, name: updated.name },
        summary: "Channel updated",
        detailsJson: auditDetailsJson({ channelId: updated._id }),
      });
    }

    return updated
      ? json(toPublicChannelRecordResponse(updated))
      : json({ error: "Channel not found" }, 404);
  }
  if (req.method === "DELETE") {
    const existing: Doc<"channelRecords"> | null = await ctx.runQuery(
      internal.channel.records.getById,
      { accountId: accountId, channelRecordId: channelId },
    );
    if (!existing) return json({ error: "Channel not found" }, 404);
    await ctx.runMutation(internal.channel.records.remove, {
      accountId: accountId,
      channelRecordId: channelId,
    });
    await writeAudit(ctx, {
      accountId: accountId,
      projectId: existing.projectId,
      stageId: existing.stageId,
      actor: actor,
      action: "deleted",
      resource: { kind: "channel", id: existing._id, name: existing.name },
      summary: "Channel deleted",
      detailsJson: auditDetailsJson({ channelId: existing._id }),
    });

    return json({ deleted: true });
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}
