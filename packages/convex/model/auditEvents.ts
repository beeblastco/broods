// Append-only, hash-chained ledger: every write goes through appendAuditEvent.

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { sha256Hex } from "./accountSecrets";
import { stableJson, stripUndefined } from "./objects";

export const AUDIT_LIST_LIMIT_MAX = 500;
const DETAILS_JSON_LIMIT_BYTES = 8 * 1024;
const ENCODER = new TextEncoder();
const TRUNCATED_MARKER = "…[truncated]";

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

export type AuditHashedFields = Omit<
  Doc<"auditEvents">,
  "_id" | "_creationTime" | "hash"
>;

export type AuditChainHead = { seq: number; hash: string } | null;

export type AuditChainRow = AuditHashedFields &
  Pick<Doc<"auditEvents">, "hash">;

export type AuditResource = Doc<"auditEvents">["resource"];

export type ChainVerification = {
  ok: boolean;
  brokenAtSeq?: number;
  checkedFrom?: number;
  checkedTo?: number;
};

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

// Convex OCC serializes concurrent appends on the head row, so seq stays gapless.
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

export async function auditChainHeadRow(
  db: QueryCtx["db"],
  accountId: Id<"accounts">,
): Promise<Doc<"auditChainHeads"> | null> {
  return await db
    .query("auditChainHeads")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .unique();
}

export function auditDetailsJson(details: Record<string, unknown>): string {
  return JSON.stringify(details);
}

export async function auditEventHash(
  fields: AuditHashedFields,
): Promise<string> {
  // Keyed by the type so a new table field fails typecheck until hashed; listed by hand since
  // a stored row also carries _id and hash. An absent field stays undefined, never null.
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

// Keep every hashed field: a reader recomputes the chain from what it was served.
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

// rows ascend by seq. Without prevHash (pruned predecessor) the first link goes unchecked:
// that row's own hash still pins its prevHash.
export async function verifyChainRows(
  rows: AuditChainRow[],
  prevHash?: string,
): Promise<ChainVerification> {
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

  // Must stay parseable JSON: a sentinel carrying a prefix, never a mid-token cut.
  return JSON.stringify({
    truncated: true,
    originalBytes: byteLength,
    prefix: `${value.slice(0, 1024)}${TRUNCATED_MARKER}`,
  });
}
