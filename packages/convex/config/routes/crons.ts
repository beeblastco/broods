/**
 * Cron CRUD (`/v1/crons*`) plus the run history at `/v1/crons/{id}/runs`.
 * Table writes and EventBridge Scheduler mutations happen in awsCrons.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  auditDetailsJson,
  type ConfigAuditActor,
} from "../../model/auditEvents";
import {
  parseCronRunsLimit,
  toCronResponse,
  toCronRunResponse,
} from "../../model/cronRules";
import { isPlainObject } from "../../model/objects";
import { json, methodNotAllowed, writeAudit } from "./shared";

/**
 * Cron CRUD: list/create on the collection, get/patch/delete by id, plus the
 * run history at /v1/crons/{id}/runs. Table writes and EventBridge Scheduler
 * mutations happen in awsCrons; mirrors core's former handleCronRoute contract.
 */
export async function handleCronRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  cronId: string | undefined,
  runs: boolean,
): Promise<Response> {
  if (runs && cronId)
    return await handleCronRunsRoute(ctx, req, accountId, cronId);
  if (!cronId)
    return await handleCronCollectionRoute(ctx, req, accountId, actor);

  if (req.method === "GET") {
    const record = await ctx
      .runQuery(internal.agent.crons.getById, {
        accountId: accountId,
        cronId: cronId as Id<"crons">,
      })
      .catch(() => null);

    return record
      ? json(toCronResponse(record))
      : json({ error: "Cron job not found" }, 404);
  }
  if (req.method === "PATCH") {
    return await patchCronRoute(ctx, req, accountId, actor, cronId);
  }
  if (req.method === "DELETE") {
    const existing = await ctx
      .runQuery(internal.agent.crons.getById, {
        accountId: accountId,
        cronId: cronId as Id<"crons">,
      })
      .catch(() => null);
    const deleted = await ctx.runAction(internal.aws.crons.remove, {
      accountId: accountId,
      cronId: cronId,
    });
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "deleted",
        resource: {
          kind: "cron",
          id: existing?._id ?? cronId,
          name: existing?.name,
        },
        summary: "Cron job deleted",
        detailsJson: auditDetailsJson({ cronId: cronId }),
      });
    }

    return deleted
      ? json({ deleted: true })
      : json({ error: "Cron job not found" }, 404);
  }

  return methodNotAllowed(["GET", "PATCH", "DELETE"]);
}

/** Collection verbs: list crons on GET, create through awsCrons on POST. */
async function handleCronCollectionRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
): Promise<Response> {
  if (req.method === "GET") {
    const records = await ctx.runQuery(internal.agent.crons.list, {
      accountId: accountId,
    });

    return json({ crons: records.map((record) => toCronResponse(record)) });
  }
  if (req.method === "POST") {
    const cron = await ctx.runAction(internal.aws.crons.create, {
      accountId: accountId,
      input: await req.json(),
    });
    const cronRecord = isPlainObject(cron) ? cron : {};
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "created",
      resource: {
        kind: "cron",
        id:
          typeof cronRecord.cronId === "string" ? cronRecord.cronId : undefined,
        name: typeof cronRecord.name === "string" ? cronRecord.name : undefined,
      },
      summary: "Cron job created",
      detailsJson:
        typeof cronRecord.cronId === "string"
          ? auditDetailsJson({ cronId: cronRecord.cronId })
          : undefined,
    });

    return json(cron, 201);
  }

  return methodNotAllowed(["GET", "POST"]);
}

/** GET the run history for one cron job, honoring the `limit` query param. */
async function handleCronRunsRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  cronId: string,
): Promise<Response> {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const limit = parseCronRunsLimit(new URL(req.url).searchParams.get("limit"));
  const records = await ctx
    .runQuery(internal.agent.crons.listRuns, {
      accountId: accountId,
      cronId: cronId as Id<"crons">,
      ...(limit !== undefined ? { limit: limit } : {}),
    })
    .catch(() => []);

  return json({ runs: records.map((record) => toCronRunResponse(record)) });
}

/** PATCH one cron through awsCrons and audit the change. */
async function patchCronRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: ConfigAuditActor,
  cronId: string,
): Promise<Response> {
  const cron = await ctx.runAction(internal.aws.crons.update, {
    accountId: accountId,
    cronId: cronId,
    patch: await req.json(),
  });
  if (cron) {
    const cronRecord = isPlainObject(cron) ? cron : {};
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: {
        kind: "cron",
        id: typeof cronRecord.cronId === "string" ? cronRecord.cronId : cronId,
        name: typeof cronRecord.name === "string" ? cronRecord.name : undefined,
      },
      summary: "Cron job updated",
      detailsJson: auditDetailsJson({ cronId: cronId }),
    });
  }

  return cron ? json(cron) : json({ error: "Cron job not found" }, 404);
}
