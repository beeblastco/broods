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
const ENCODER = new TextEncoder();
const TRUNCATED_MARKER = "…[truncated]";

/** Who wrote a row; the schema validator is the one list of kinds. */
export type AuditActor = Doc<"auditEvents">["actor"];

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

/** The fields the row hash covers: every stored field but the hash itself. */
export type AuditHashedFields = Omit<
  Doc<"auditEvents">,
  "_id" | "_creationTime" | "hash"
>;

/** The ledger tip; null for an account that has never written a row. */
export type AuditChainHead = { seq: number; hash: string } | null;

/** A stored row as `verifyChainRows` reads it: the hashed fields plus the hash. */
export type AuditChainRow = AuditHashedFields &
  Pick<Doc<"auditEvents">, "hash">;

/** What a row is about; the schema validator is the one list of kinds. */
export type AuditResource = Doc<"auditEvents">["resource"];

export type ChainVerification = {
  ok: boolean;
  /** First row whose hash or link does not match; absent when `ok`. */
  brokenAtSeq?: number;
  /** The seq range that was recomputed, when any row was. */
  checkedFrom?: number;
  checkedTo?: number;
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
  const head = await auditChainHeadRow(db, event.accountId);
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
    projectId: event.projectId,
    stageId: event.stageId,
    traceId: event.traceId,
  };
  const hash = await auditEventHash(hashed);
  const rowId = await db.insert("auditEvents", { ...hashed, hash: hash });
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
 * The account's ledger tip row, or null before its first append.
 * @param db Convex database reader.
 * @param accountId the account whose chain to read.
 */
export async function auditChainHeadRow(
  db: QueryCtx["db"],
  accountId: Id<"accounts">,
): Promise<Doc<"auditChainHeads"> | null> {
  return await db
    .query("auditChainHeads")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .unique();
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
 * sha256 hex of the canonical JSON (sorted keys) of every row field but the
 * hash. An absent optional field is left out of the JSON, never written as
 * null, so a row hashes the same however it was read.
 */
export async function auditEventHash(
  fields: AuditHashedFields,
): Promise<string> {
  // Keyed by the type, so a field added to the table fails the typecheck
  // here until it is hashed. Listed one by one because a stored row passed
  // in also carries `_id` and `hash`.
  const canonical: Record<keyof AuditHashedFields, unknown> = {
    accountId: fields.accountId,
    seq: fields.seq,
    prevHash: fields.prevHash,
    at: fields.at,
    actor: fields.actor,
    action: fields.action,
    resource: fields.resource,
    summary: fields.summary,
    detailsJson: fields.detailsJson,
    projectId: fields.projectId,
    stageId: fields.stageId,
    traceId: fields.traceId,
  };

  return await sha256Hex(stableJson(canonical));
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
  return {
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
  };
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
  // Each hash depends only on its own row, so they recompute in parallel;
  // only the links are walked in order.
  const hashes = await Promise.all(rows.map(auditEventHash));
  let expectedPrevHash = prevHash;
  let expectedSeq: number | undefined;
  for (const [index, row] of rows.entries()) {
    const linked =
      (expectedSeq === undefined || row.seq === expectedSeq) &&
      (expectedPrevHash === undefined || row.prevHash === expectedPrevHash) &&
      (row.seq !== 1 || row.prevHash === "");
    if (!linked || hashes[index] !== row.hash) {
      return { ok: false, brokenAtSeq: row.seq };
    }
    expectedPrevHash = row.hash;
    expectedSeq = row.seq + 1;
  }

  return { ok: true };
}

function capDetailsJson(value: string): string {
  // A UTF-16 unit encodes to at most three bytes, so a short string needs no encode.
  if (value.length * 3 <= DETAILS_JSON_LIMIT_BYTES) return value;
  const byteLength = ENCODER.encode(value).byteLength;
  if (byteLength <= DETAILS_JSON_LIMIT_BYTES) return value;

  // The field must stay parseable JSON, so an oversized payload is replaced
  // with a sentinel carrying a prefix rather than truncated mid-token.
  return JSON.stringify({
    truncated: true,
    originalBytes: byteLength,
    prefix: `${value.slice(0, 1024)}${TRUNCATED_MARKER}`,
  });
}
