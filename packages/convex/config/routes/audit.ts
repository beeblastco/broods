/**
 * The audit ledger routes (`/v1/audit*`): rows since a seq, chain
 * verification, and the one webhook sink per account. The router already
 * checked a role session against `audit:read` / `audit:write`.
 */

import { type ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { encryptAgentConfigBlob } from "../../model/agentConfigCodec";
import {
  AUDIT_LIST_LIMIT_MAX,
  auditDetailsJson,
  publicAuditEvent,
  type AuditActor,
  type AuditChainHead,
  type ChainVerification,
} from "../../model/auditEvents";
import { normalizeAuditSinkInput } from "../../model/auditSinks";
import {
  configEncryptionSecret,
  json,
  jsonError,
  methodNotAllowed,
  parseJsonRequest,
  writeAudit,
} from "./shared";

const DEFAULT_LIST_LIMIT = 100;

export type AuditLeaf = "events" | "verify" | "sink";

/** Serve one `/v1/audit*` leaf; ledger reads are GET only, the sink takes GET, PUT and DELETE. */
export async function handleAuditRoute(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
  actor: AuditActor,
  leaf: AuditLeaf,
): Promise<Response> {
  if (leaf === "events") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);

    return await listResponse(ctx, req, accountId);
  }
  if (leaf === "verify") {
    if (req.method !== "GET") return methodNotAllowed(["GET"]);

    return await verifyResponse(ctx, req, accountId);
  }
  if (req.method === "GET") {
    const sink: Doc<"auditSinks"> | null = await ctx.runQuery(
      internal.audit.sinks.get,
      { accountId: accountId },
    );

    return sink ? json(publicSink(sink)) : jsonError(404, "No audit sink");
  }
  if (req.method === "PUT") {
    const input = normalizeAuditSinkInput(await parseJsonRequest(req));
    const blob = await encryptAgentConfigBlob(
      { secret: input.secret },
      configEncryptionSecret(),
    );
    const sink: Doc<"auditSinks"> = await ctx.runMutation(
      internal.audit.sinks.put,
      {
        accountId: accountId,
        url: input.url,
        encryptedSecret: blob.ciphertext,
        secretIv: blob.iv,
        secretTag: blob.tag,
      },
    );
    await writeAudit(ctx, {
      accountId: accountId,
      actor: actor,
      action: "updated",
      resource: { kind: "auditSink", id: sink._id },
      summary: "Audit sink set",
      detailsJson: auditDetailsJson({ url: sink.url }),
    });

    return json(publicSink(sink));
  }
  if (req.method === "DELETE") {
    const deleted: boolean = await ctx.runMutation(
      internal.audit.sinks.remove,
      { accountId: accountId },
    );
    if (deleted) {
      await writeAudit(ctx, {
        accountId: accountId,
        actor: actor,
        action: "deleted",
        resource: { kind: "auditSink" },
        summary: "Audit sink removed",
      });
    }

    return json({ deleted: deleted });
  }

  return methodNotAllowed(["GET", "PUT", "DELETE"]);
}

/** `/v1/audit`, `/v1/audit/verify`, `/v1/audit/sink`; null for anything else. */
export function parseAuditRoute(pathname: string): AuditLeaf | null {
  if (pathname === "/v1/audit") return "events";
  if (pathname === "/v1/audit/verify") return "verify";
  if (pathname === "/v1/audit/sink") return "sink";

  return null;
}

/** A non-negative integer query param: undefined when absent, null when malformed. */
function integerParam(url: URL, name: string): number | null | undefined {
  const raw = url.searchParams.get(name)?.trim();
  if (raw === undefined || raw === "") return undefined;

  return /^\d+$/.test(raw) ? Number(raw) : null;
}

/** `GET /v1/audit`: one page of rows after `since`, with the chain head. */
async function listResponse(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
): Promise<Response> {
  const url = new URL(req.url);
  const since = integerParam(url, "since") ?? 0;
  if (since === null) {
    return jsonError(400, "since must be a non-negative integer.", {
      code: "invalid_since",
      param: "since",
    });
  }
  const limit = integerParam(url, "limit") ?? DEFAULT_LIST_LIMIT;
  if (limit === null || limit < 1 || limit > AUDIT_LIST_LIMIT_MAX) {
    return jsonError(
      400,
      `limit must be an integer between 1 and ${AUDIT_LIST_LIMIT_MAX}.`,
      { code: "invalid_limit", param: "limit" },
    );
  }
  // Two snapshots: `head` may already sit past the page, which is what a
  // reader paging toward the tip expects.
  const [rows, head]: [Doc<"auditEvents">[], AuditChainHead] =
    await Promise.all([
      ctx.runQuery(internal.audit.ledger.list, {
        accountId: accountId,
        since: since,
        limit: limit,
      }),
      ctx.runQuery(internal.audit.ledger.head, { accountId: accountId }),
    ]);
  const events = rows.map(publicAuditEvent);

  return json({
    events: events,
    nextSince: events[events.length - 1]?.seq ?? since,
    head: head,
  });
}

/** The sink as the API serves it: never the encrypted secret. */
function publicSink(sink: Doc<"auditSinks">): Record<string, unknown> {
  return {
    kind: sink.kind,
    url: sink.url,
    exportedSeq: sink.exportedSeq,
    ...(sink.lastError ? { lastError: sink.lastError } : {}),
    updatedAt: new Date(sink.updatedAt).toISOString(),
  };
}

/** `GET /v1/audit/verify`: recompute the chain over an optional seq range. */
async function verifyResponse(
  ctx: ActionCtx,
  req: Request,
  accountId: Id<"accounts">,
): Promise<Response> {
  const url = new URL(req.url);
  const fromSeq = integerParam(url, "fromSeq");
  const toSeq = integerParam(url, "toSeq");
  if (!fromSeq && fromSeq !== undefined) {
    return jsonError(400, "fromSeq must be a positive integer.", {
      code: "invalid_range",
      param: "fromSeq",
    });
  }
  if (!toSeq && toSeq !== undefined) {
    return jsonError(400, "toSeq must be a positive integer.", {
      code: "invalid_range",
      param: "toSeq",
    });
  }
  if (fromSeq !== undefined && toSeq !== undefined && fromSeq > toSeq) {
    return jsonError(400, "fromSeq must not be greater than toSeq.", {
      code: "invalid_range",
      param: "fromSeq",
    });
  }
  const result: ChainVerification = await ctx.runQuery(
    internal.audit.ledger.verifyChain,
    {
      accountId: accountId,
      fromSeq: fromSeq,
      toSeq: toSeq,
    },
  );

  return json(result);
}
