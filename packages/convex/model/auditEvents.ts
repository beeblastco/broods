/**
 * The account audit ledger: hash-chained, append-only rows for config
 * mutations, run lifecycle and enforced tool denials. Every writer goes
 * through `appendAuditEvent`; `verifyChainRows` is the one place a chain is
 * recomputed, shared by the internal query and the tests.
 */

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./accountSecrets";
import { stableJson, stripUndefined } from "./objects";

/** Most rows one `GET /v1/audit` page or one sink batch carries. */
export const AUDIT_LIST_LIMIT_MAX = 500;
const DETAILS_JSON_LIMIT_BYTES = 8 * 1024;
const TRUNCATED_MARKER = "…[truncated]";

export type AuditActor = {
  kind:
    | "dashboardUser"
    | "apiAccountSecret"
    | "admin"
    | "service"
    | "cli"
    | "deployKey"
    | "role"
    | "agent";
  id?: string;
  email?: string;
  name?: string;
  agentId?: string;
};

export type AuditEventInput = {
  accountId: Id<"accounts">;
  projectId?: Id<"projects">;
  stageId?: Id<"stages">;
  traceId?: string;
  actor: AuditActor;
  action: string;
  resource: AuditResource;
  summary: string;
  detailsJson?: string;
};

/** The fields the row hash covers, in the order `auditEventHash` serializes them. */
export type AuditHashedFields = Pick<
  Doc<"auditEvents">,
  | "accountId"
  | "seq"
  | "prevHash"
  | "at"
  | "actor"
  | "action"
  | "resource"
  | "summary"
  | "detailsJson"
>;

/** The ledger tip; null for an account that has never written a row. */
export type AuditChainHead = { seq: number; hash: string } | null;

/** A stored row as `verifyChainRows` reads it: the hashed fields plus the hash. */
export type AuditChainRow = AuditHashedFields &
  Pick<Doc<"auditEvents">, "hash">;

export type AuditResource = {
  kind:
    | "account"
    | "agent"
    | "skill"
    | "hook"
    | "mcp"
    | "workspace"
    | "workspaceFile"
    | "cron"
    | "sandbox"
    | "policy"
    | "role"
    | "channel"
    | "environmentVariable"
    | "deployment"
    | "webhook"
    | "manifest"
    | "run"
    | "tool"
    | "auditSink"
    | "unknown";
  id?: string;
  name?: string;
};

export type ChainVerification = {
  ok: boolean;
  /** First row whose hash or link does not match; absent when `ok`. */
  brokenAtSeq?: number;
};

/** A ledger row as `GET /v1/audit` and the webhook sink serve it. */
export type PublicAuditEvent = {
  accountId: string;
  seq: number;
  prevHash: string;
  hash: string;
  at: number;
  actor: AuditActor;
  action: string;
  resource: AuditResource;
  summary: string;
  detailsJson?: string;
  projectId?: string;
  stageId?: string;
  traceId?: string;
};

/**
 * @param ctx Convex query or mutation context.
 * @param projectId project whose org owns the account.
 * @returns the account id, or null before account provisioning.
 */
export async function accountIdForProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
): Promise<Id<"accounts"> | null> {
  const project = await ctx.db.get(projectId);
  if (!project) return null;
  const account = await ctx.db
    .query("accounts")
    .withIndex("by_orgId", (q) => q.eq("orgId", project.orgId))
    .unique();

  return account?._id ?? null;
}

/**
 * Append one row to the account's ledger. Reads the chain head, links the new
 * row to it and moves the head; Convex OCC serializes concurrent appends on
 * the head row, so `seq` stays gapless.
 * @param db Convex database writer.
 * @param event sanitized event metadata.
 * @returns the inserted row id.
 */
export async function appendAuditEvent(
  db: MutationCtx["db"],
  event: AuditEventInput,
): Promise<Id<"auditEvents">> {
  const head = await db
    .query("auditChainHeads")
    .withIndex("by_accountId", (q) => q.eq("accountId", event.accountId))
    .unique();
  const hashed: AuditHashedFields = {
    accountId: event.accountId,
    seq: (head?.seq ?? 0) + 1,
    prevHash: head?.hash ?? "",
    at: Date.now(),
    actor: stripUndefined(event.actor),
    action: event.action,
    resource: stripUndefined(event.resource),
    summary: event.summary,
    ...(event.detailsJson === undefined
      ? {}
      : { detailsJson: capDetailsJson(event.detailsJson) }),
  };
  const hash = await auditEventHash(hashed);
  const rowId = await db.insert("auditEvents", {
    ...hashed,
    hash: hash,
    projectId: event.projectId,
    stageId: event.stageId,
    traceId: event.traceId,
  });
  if (head) {
    await db.patch(head._id, { seq: hashed.seq, hash: hash });
  } else {
    await db.insert("auditChainHeads", {
      accountId: event.accountId,
      seq: hashed.seq,
      hash: hash,
    });
  }

  return rowId;
}

/**
 * Serialize small non-secret metadata for the detailsJson field. Plain
 * JSON.stringify; `appendAuditEvent` caps oversized payloads.
 * @param details ids, names, counts, or other non-secret metadata.
 * @returns JSON string.
 */
export function auditDetailsJson(details: Record<string, unknown>): string {
  return JSON.stringify(details);
}

/**
 * sha256 hex of the canonical JSON (sorted keys) of the hashed fields. Only
 * these fields count, so a row can carry ids and trace references the hash
 * does not need to pin.
 */
export async function auditEventHash(
  fields: AuditHashedFields,
): Promise<string> {
  return await sha256Hex(
    stableJson({
      accountId: fields.accountId,
      seq: fields.seq,
      prevHash: fields.prevHash,
      at: fields.at,
      actor: fields.actor,
      action: fields.action,
      resource: fields.resource,
      summary: fields.summary,
      detailsJson: fields.detailsJson,
    }),
  );
}

/**
 * @param user AuthKit user metadata.
 * @returns audit actor fields for a dashboard mutation.
 */
export function dashboardAuditActor(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}): AuditActor {
  return {
    kind: "dashboardUser",
    id: user.id,
    ...(user.email ? { email: user.email } : {}),
    ...(user.name ? { name: user.name } : {}),
  };
}

/**
 * Strip the Convex system fields; everything the hash covers stays, so a
 * reader can recompute the chain from what it was served.
 * @param row stored ledger row
 * @returns the public row
 */
export function publicAuditEvent(row: Doc<"auditEvents">): PublicAuditEvent {
  return stripUndefined({
    accountId: row.accountId,
    seq: row.seq,
    prevHash: row.prevHash,
    hash: row.hash,
    at: row.at,
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    summary: row.summary,
    detailsJson: row.detailsJson,
    projectId: row.projectId,
    stageId: row.stageId,
    traceId: row.traceId,
  });
}

/**
 * Recompute every row's hash and check each link to the row before it. Rows
 * must be in ascending `seq`. The first row is linked against `prevHash` when
 * the caller knows it (the row before the range, or "" at seq 1); a pruned
 * predecessor leaves it unchecked, since its own hash still pins `prevHash`.
 * @param rows the stored rows to verify
 * @param prevHash hash the first row must link to, when known
 * @returns ok, or the first seq that fails
 */
export async function verifyChainRows(
  rows: AuditChainRow[],
  prevHash?: string,
): Promise<ChainVerification> {
  let expectedPrevHash = prevHash;
  let expectedSeq: number | undefined;
  for (const row of rows) {
    const linked =
      (expectedSeq === undefined || row.seq === expectedSeq) &&
      (expectedPrevHash === undefined || row.prevHash === expectedPrevHash) &&
      (row.seq !== 1 || row.prevHash === "");
    if (!linked || (await auditEventHash(row)) !== row.hash) {
      return { ok: false, brokenAtSeq: row.seq };
    }
    expectedPrevHash = row.hash;
    expectedSeq = row.seq + 1;
  }

  return { ok: true };
}

function capDetailsJson(value: string): string {
  const encoder = new TextEncoder();
  const byteLength = encoder.encode(value).byteLength;
  if (byteLength <= DETAILS_JSON_LIMIT_BYTES) return value;

  // The field must stay parseable JSON, so an oversized payload is replaced
  // with a sentinel carrying a prefix rather than truncated mid-token.
  return JSON.stringify({
    truncated: true,
    originalBytes: byteLength,
    prefix: `${value.slice(0, 1024)}${TRUNCATED_MARKER}`,
  });
}
