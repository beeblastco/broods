/**
 * Audit webhook sinks: one per account, upserted from the config route, and
 * the cron export that posts unexported ledger rows to it with an HMAC
 * signature and advances the watermark the prune reads.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import { decryptAgentConfigBlob } from "../model/agentConfigCodec";
import { publicAuditEvent } from "../model/auditEvents";
import { AUDIT_SIGNATURE_HEADER, signAuditExport } from "../model/auditSinks";
import { configEncryptionSecret } from "../config/routes/shared";
import { auditSinksFields } from "../schema";

const EXPORT_BATCH_SIZE = 200;
const DUE_SINKS_MAX = 100;
const ERROR_MAX_LENGTH = 500;

const auditSinkDoc = v.object({
  ...auditSinksFields,
  _id: v.id("auditSinks"),
  _creationTime: v.number(),
});

/** The sink row for one account, or null. */
export const get = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.union(auditSinkDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"auditSinks"> | null> => {
    return await ctx.db
      .query("auditSinks")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
  },
});

/** Sinks whose account ledger has rows past their watermark. */
export const listDue = internalQuery({
  args: {},
  returns: v.array(auditSinkDoc),
  handler: async (ctx): Promise<Doc<"auditSinks">[]> => {
    const sinks = await ctx.db.query("auditSinks").take(DUE_SINKS_MAX);
    const due: Doc<"auditSinks">[] = [];
    for (const sink of sinks) {
      const tip = await ctx.db
        .query("auditChainHeads")
        .withIndex("by_accountId", (q) => q.eq("accountId", sink.accountId))
        .unique();
      if (tip && tip.seq > sink.exportedSeq) due.push(sink);
    }

    return due;
  },
});

/** Cron: post every due sink its next batch. One sink's failure never stops the rest. */
export const exportDue = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const due: Doc<"auditSinks">[] = await ctx.runQuery(
      internal.audit.sinks.listDue,
      {},
    );
    for (const sink of due) await exportSink(ctx, sink);

    return null;
  },
});

/** Record a failed delivery; the watermark stays where it was. */
export const markError = internalMutation({
  args: { sinkId: v.id("auditSinks"), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    if (await ctx.db.get(args.sinkId)) {
      await ctx.db.patch(args.sinkId, {
        lastError: args.error.slice(0, ERROR_MAX_LENGTH),
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

/** Advance the watermark after a 2xx; never moves it backwards. */
export const markExported = internalMutation({
  args: { sinkId: v.id("auditSinks"), exportedSeq: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const sink = await ctx.db.get(args.sinkId);
    if (sink && sink.exportedSeq < args.exportedSeq) {
      await ctx.db.patch(args.sinkId, {
        exportedSeq: args.exportedSeq,
        lastError: undefined,
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

/**
 * Create or replace the account's sink. A new url or secret keeps the
 * watermark: the ledger is one stream, and the receiver that moved still
 * wants only what it has not seen.
 */
export const put = internalMutation({
  args: {
    accountId: v.id("accounts"),
    url: v.string(),
    encryptedSecret: v.string(),
    secretIv: v.string(),
    secretTag: v.string(),
  },
  returns: v.id("auditSinks"),
  handler: async (ctx, args): Promise<Id<"auditSinks">> => {
    const existing = await ctx.db
      .query("auditSinks")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    const fields = {
      url: args.url,
      encryptedSecret: args.encryptedSecret,
      secretIv: args.secretIv,
      secretTag: args.secretTag,
      lastError: undefined,
      updatedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.patch(existing._id, fields);

      return existing._id;
    }

    return await ctx.db.insert("auditSinks", {
      accountId: args.accountId,
      kind: "webhook",
      exportedSeq: 0,
      ...fields,
    });
  },
});

/** Delete the account's sink. Returns whether one existed. */
export const remove = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const existing = await ctx.db
      .query("auditSinks")
      .withIndex("by_accountId", (q) => q.eq("accountId", args.accountId))
      .unique();
    if (!existing) return false;
    await ctx.db.delete(existing._id);

    return true;
  },
});

/** Post one batch to one sink and record the outcome. */
async function exportSink(
  ctx: ActionCtx,
  sink: Doc<"auditSinks">,
): Promise<void> {
  const rows: Doc<"auditEvents">[] = await ctx.runQuery(
    internal.audit.ledger.list,
    {
      accountId: sink.accountId,
      since: sink.exportedSeq,
      limit: EXPORT_BATCH_SIZE,
    },
  );
  const last = rows[rows.length - 1];
  if (!last) return;
  const decrypted = await decryptAgentConfigBlob(
    {
      ciphertext: sink.encryptedSecret,
      iv: sink.secretIv,
      tag: sink.secretTag,
    },
    configEncryptionSecret(),
  );
  const secret = decrypted?.secret;
  if (typeof secret !== "string") {
    await ctx.runMutation(internal.audit.sinks.markError, {
      sinkId: sink._id,
      error: "Sink secret cannot be decrypted; set it again",
    });

    return;
  }

  const body = JSON.stringify(rows.map(publicAuditEvent));
  let outcome: string | null;
  try {
    // No redirects: the signed body goes to the host the account named or
    // nowhere, so a 3xx counts as a failed delivery.
    const response = await fetch(sink.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUDIT_SIGNATURE_HEADER]: await signAuditExport(secret, body),
      },
      body: body,
      redirect: "manual",
    });
    outcome = response.ok ? null : `HTTP ${response.status}`;
  } catch (err) {
    outcome = err instanceof Error ? err.message : String(err);
  }

  if (outcome === null) {
    await ctx.runMutation(internal.audit.sinks.markExported, {
      sinkId: sink._id,
      exportedSeq: last.seq,
    });
  } else {
    await ctx.runMutation(internal.audit.sinks.markError, {
      sinkId: sink._id,
      error: outcome,
    });
  }
}
