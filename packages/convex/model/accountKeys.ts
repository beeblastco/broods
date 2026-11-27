// Must not import the generated api: the forwarders reach a type here through
// `channel/connections.ts`, and the api would pull every module into them.

import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { accountIdForProject } from "./auditEvents";
import { ClientError } from "./clientError";
import {
  AccountCipher,
  type BlobScope,
  createWrappedAccountKey,
  type EncryptedBlob,
  ENVELOPE_COLUMNS,
  ENVELOPE_TABLES,
  type EnvelopeTable,
  type WrappedAccountKey,
} from "./envelope";

const REENCRYPT_BATCH_SIZE = 50;

// Typed so a listed column the schema does not have fails to compile.
const SCHEMA_COLUMNS: readonly SchemaColumn[] = ENVELOPE_COLUMNS;

const requestCiphers = new WeakMap<
  QueryCtx | MutationCtx,
  Map<Id<"accounts">, AccountCipher>
>();

export const reencryptWalkArgs = {
  table: v.optional(
    v.union(...ENVELOPE_TABLES.map((table) => v.literal(table))),
  ),
  cursor: v.optional(v.union(v.string(), v.null())),
};

type SchemaColumn = {
  [T in EnvelopeTable]: {
    table: T;
    scope: BlobScope;
    ciphertext: keyof Doc<T>;
    iv: keyof Doc<T>;
    tag: keyof Doc<T>;
  };
}[EnvelopeTable];

export async function accountCipher(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
): Promise<AccountCipher> {
  let ciphers = requestCiphers.get(ctx);
  if (!ciphers) {
    ciphers = new Map();
    requestCiphers.set(ctx, ciphers);
  }
  let cipher = ciphers.get(accountId);
  if (!cipher) {
    cipher = cipherFromKeys(accountId, await listWrappedKeys(ctx, accountId));
    ciphers.set(accountId, cipher);
  }

  return cipher;
}

export async function accountCipherForWrite(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<AccountCipher> {
  const cipher = await accountCipher(ctx, accountId);
  if (cipher.keyId !== null) return cipher;
  await mintKey(ctx, accountId);

  return await accountCipher(ctx, accountId);
}

// For blobs an HTTP action sealed outside this mutation: a rotation in between retired their
// key and would strand the row, so the caller retries under the new key.
export async function assertSealedUnderCurrentKey(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
  ciphertexts: Array<string | undefined>,
): Promise<void> {
  const sealed = ciphertexts.filter((ciphertext) => ciphertext !== undefined);
  if (sealed.length === 0) return;
  const cipher = await accountCipher(ctx, accountId);
  if (
    sealed.some((ciphertext) => cipher.needsRewrite({ ciphertext: ciphertext }))
  ) {
    throw new ClientError(
      "The account's encryption key changed during this request; retry",
      "conflict",
    );
  }
}

export function cipherFromKeys(
  accountId: Id<"accounts">,
  keys: WrappedAccountKey[],
): AccountCipher {
  return new AccountCipher(accountId, encryptionSecrets(), keys);
}

// Split as core's `requireSecretsEnv` does: the first secret wraps, every one unwraps.
export function encryptionSecrets(): string[] {
  const secrets = [
    ...new Set(
      (process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  if (secrets.length === 0) {
    throw new Error("ACCOUNT_CONFIG_ENCRYPTION_SECRET is required");
  }

  return secrets;
}

export async function ensureWrappedKeys(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<WrappedAccountKey[]> {
  const keys = await listWrappedKeys(ctx, accountId);
  if (keys.some((key) => key.retiredAt === undefined)) return keys;

  return [...keys, await mintKey(ctx, accountId)];
}

export function hasEncryptionSecret(): boolean {
  return Boolean(process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET);
}

export async function listWrappedKeys(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
): Promise<WrappedAccountKey[]> {
  const rows = await ctx.db
    .query("accountKeys")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .collect();

  return rows.map((row) => ({
    keyId: row.keyId,
    kekId: row.kekId,
    wrappedKey: row.wrappedKey,
    retiredAt: row.retiredAt,
  }));
}

export async function mintKey(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<WrappedAccountKey> {
  const created = await createWrappedAccountKey(accountId, encryptionSecrets());
  await ctx.db.insert("accountKeys", {
    ...created,
    accountId: accountId,
    createdAt: Date.now(),
  });
  requestCiphers.get(ctx)?.delete(accountId);

  return created;
}

// Pages every table in full even with `accountId`: two have no account index. A blob that
// does not decrypt throws, so a bad secret stops the walk instead of skipping rows.
export async function reencryptBatch(
  ctx: MutationCtx,
  args: {
    table?: EnvelopeTable;
    cursor?: string | null;
    accountId?: Id<"accounts">;
  },
): Promise<{
  patched: number;
  skipped: number;
  next: { table: EnvelopeTable; cursor: string | null } | null;
}> {
  const table = args.table ?? ENVELOPE_COLUMNS[0].table;
  const page = await ctx.db
    .query(table)
    .paginate({ numItems: REENCRYPT_BATCH_SIZE, cursor: args.cursor ?? null });
  let patched = 0;
  let skipped = 0;
  for (const row of page.page) {
    const accountId = await accountIdForRow(ctx, row);
    if (!accountId) {
      skipped += 1;
      continue;
    }
    if (args.accountId && accountId !== args.accountId) continue;
    const patch = await reencryptRow(
      table,
      row,
      await accountCipherForWrite(ctx, accountId),
    );
    if (!patch) continue;
    // `SCHEMA_COLUMNS` proves these fields exist; a runtime-chosen table's row type cannot.
    await ctx.db.patch(row._id, patch as Partial<Doc<EnvelopeTable>>);
    patched += 1;
  }
  if (!page.isDone) {
    return {
      patched: patched,
      skipped: skipped,
      next: { table: table, cursor: page.continueCursor },
    };
  }
  const following = ENVELOPE_TABLES[ENVELOPE_TABLES.indexOf(table) + 1];

  return {
    patched: patched,
    skipped: skipped,
    next: following ? { table: following, cursor: null } : null,
  };
}

export async function requireAccountIdForProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
): Promise<Id<"accounts">> {
  const accountId = await accountIdForProject(ctx, projectId);
  if (!accountId) {
    throw new ClientError(
      "Account is still being provisioned; retry in a moment",
      "conflict",
    );
  }

  return accountId;
}

async function accountIdForRow(
  ctx: MutationCtx,
  row: Doc<EnvelopeTable>,
): Promise<Id<"accounts"> | null> {
  if ("accountId" in row) return row.accountId;
  if ("projectId" in row) return await accountIdForProject(ctx, row.projectId);
  const config = await ctx.db.get(row.agentConfigId);

  return config ? await accountIdForProject(ctx, config.projectId) : null;
}

function blobAt(
  row: Record<string, unknown>,
  column: SchemaColumn,
): EncryptedBlob | null {
  const ciphertext = row[column.ciphertext];
  const iv = row[column.iv];
  const tag = row[column.tag];

  return typeof ciphertext === "string" &&
    typeof iv === "string" &&
    typeof tag === "string"
    ? { ciphertext: ciphertext, iv: iv, tag: tag }
    : null;
}

async function reencryptRow(
  table: EnvelopeTable,
  row: Doc<EnvelopeTable>,
  cipher: AccountCipher,
): Promise<Record<string, string> | null> {
  const fields: Record<string, unknown> = row;
  const patch: Record<string, string> = {};
  for (const column of SCHEMA_COLUMNS) {
    if (column.table !== table) continue;
    const blob = blobAt(fields, column);
    if (!blob || !cipher.needsRewrite(blob)) continue;
    const value = await cipher.decrypt(column.scope, blob);
    if (!value) {
      throw new Error(`${table} ${row._id} ${column.scope} does not decrypt`);
    }
    const next = await cipher.encrypt(column.scope, value);
    patch[column.ciphertext] = next.ciphertext;
    patch[column.iv] = next.iv;
    patch[column.tag] = next.tag;
    // The digest is keyed by the DEK, so it moves with the blob.
    if (table === "environmentVariables" && typeof value.value === "string") {
      patch.valueDigest = await cipher.digest(value.value);
    }
  }

  return Object.keys(patch).length === 0 ? null : patch;
}
