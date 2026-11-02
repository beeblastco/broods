import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "../_generated/server";
import { assertSealedUnderCurrentKey } from "../model/accountKeys";
import { auditChainHeadRow, publicAuditEvent } from "../model/auditEvents";
import {
  AUDIT_SIGNATURE_HEADER,
  auditSinkRow,
  signAuditExport,
} from "../model/auditSinks";
import { accountCipherForAction } from "../config/routes/shared";
import { auditSinksFields } from "../schema";

const DUE_SINKS_PAGE_SIZE = 100;
const ERROR_MAX_LENGTH = 500;
const EXPORT_BATCH_SIZE = 200;
const EXPORT_BATCHES_PER_TICK = 10;
const EXPORT_TIMEOUT_MS = 10_000;

const auditSinkDoc = v.object({
  ...auditSinksFields,
  _id: v.id("auditSinks"),
  _creationTime: v.number(),
});

type DueSinksPage = { due: Doc<"auditSinks">[]; cursor: string | null };

export const exportDue = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    let cursor: string | null = null;
    do {
      const page: DueSinksPage = await ctx.runQuery(
        internal.audit.sinks.listDue,
        { cursor: cursor },
      );
      const outcomes = await Promise.allSettled(
        page.due.map((sink) => exportSink(ctx, sink)),
      );
      // Delivery failures land on the sink row; this is the export itself failing.
      for (const [index, outcome] of outcomes.entries()) {
        if (outcome.status === "rejected") {
          console.error("Audit sink export failed", {
            sinkId: page.due[index]?._id,
            error: String(outcome.reason),
          });
        }
      }
      cursor = page.cursor;
    } while (cursor !== null);

    return null;
  },
});

export const get = internalQuery({
  args: { accountId: v.id("accounts") },
  returns: v.union(auditSinkDoc, v.null()),
  handler: async (ctx, args): Promise<Doc<"auditSinks"> | null> => {
    return await auditSinkRow(ctx.db, args.accountId);
  },
});

export const listDue = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    due: v.array(auditSinkDoc),
    cursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args): Promise<DueSinksPage> => {
    const page = await ctx.db
      .query("auditSinks")
      .paginate({ numItems: DUE_SINKS_PAGE_SIZE, cursor: args.cursor });
    const tips = await Promise.all(
      page.page.map((sink) => auditChainHeadRow(ctx.db, sink.accountId)),
    );

    return {
      due: page.page.filter((sink, index) => {
        const tip = tips[index];

        return tip !== null && tip !== undefined && tip.seq > sink.exportedSeq;
      }),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});

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

// A new url or secret keeps the watermark: the moved receiver wants only what it has not seen.
export const put = internalMutation({
  args: {
    accountId: v.id("accounts"),
    url: v.string(),
    encryptedSecret: v.string(),
    secretIv: v.string(),
    secretTag: v.string(),
  },
  returns: auditSinkDoc,
  handler: async (ctx, args): Promise<Doc<"auditSinks">> => {
    await assertSealedUnderCurrentKey(ctx, args.accountId, [
      args.encryptedSecret,
    ]);
    const existing = await auditSinkRow(ctx.db, args.accountId);
    const fields = {
      url: args.url,
      encryptedSecret: args.encryptedSecret,
      secretIv: args.secretIv,
      secretTag: args.secretTag,
      lastError: undefined,
      updatedAt: Date.now(),
    };
    const sinkId = existing
      ? existing._id
      : await ctx.db.insert("auditSinks", {
          accountId: args.accountId,
          kind: "webhook",
          exportedSeq: 0,
          ...fields,
        });
    if (existing) await ctx.db.patch(sinkId, fields);
    const sink = await ctx.db.get(sinkId);
    if (!sink) throw new Error("Audit sink vanished during put");

    return sink;
  },
});

export const remove = internalMutation({
  args: { accountId: v.id("accounts") },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<boolean> => {
    const existing = await auditSinkRow(ctx.db, args.accountId);
    if (!existing) return false;
    await ctx.db.delete(existing._id);

    return true;
  },
});

async function exportSink(
  ctx: ActionCtx,
  sink: Doc<"auditSinks">,
): Promise<void> {
  const cipher = await accountCipherForAction(ctx, sink.accountId, "read");
  const decrypted = await cipher.decrypt("auditSinks:encryptedSecret", {
    ciphertext: sink.encryptedSecret,
    iv: sink.secretIv,
    tag: sink.secretTag,
  });
  const secret = decrypted?.secret;
  if (typeof secret !== "string") {
    await ctx.runMutation(internal.audit.sinks.markError, {
      sinkId: sink._id,
      error: "Sink secret cannot be decrypted; set it again",
    });

    return;
  }

  let since = sink.exportedSeq;
  for (let batch = 0; batch < EXPORT_BATCHES_PER_TICK; batch += 1) {
    const rows: Doc<"auditEvents">[] = await ctx.runQuery(
      internal.audit.ledger.list,
      { accountId: sink.accountId, since: since, limit: EXPORT_BATCH_SIZE },
    );
    const last = rows[rows.length - 1];
    if (!last) return;
    const failure = await postBatch(sink.url, secret, rows);
    if (failure !== null) {
      await ctx.runMutation(internal.audit.sinks.markError, {
        sinkId: sink._id,
        error: failure,
      });

      return;
    }
    await ctx.runMutation(internal.audit.sinks.markExported, {
      sinkId: sink._id,
      exportedSeq: last.seq,
    });
    if (rows.length < EXPORT_BATCH_SIZE) return;
    since = last.seq;
  }
}

async function postBatch(
  url: string,
  secret: string,
  rows: Doc<"auditEvents">[],
): Promise<string | null> {
  const body = JSON.stringify(rows.map(publicAuditEvent));
  try {
    // No redirects: the signed body goes to the host the account named or nowhere.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUDIT_SIGNATURE_HEADER]: await signAuditExport(secret, body),
      },
      body: body,
      redirect: "manual",
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });

    return response.ok ? null : `HTTP ${response.status}`;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
