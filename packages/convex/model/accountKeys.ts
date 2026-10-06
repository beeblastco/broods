/**
 * The Convex side of envelope encryption: builds an `AccountCipher` from the
 * account's `accountKeys` rows, mints the first key on the first write, and
 * walks every encrypted table so a rotation can rewrite blobs in bounded
 * batches. The codec itself is `./envelope.ts`; the internal functions that
 * expose this live in `account/keys.ts`.
 * It must not import the generated api: the forwarders import a type through
 * `channel/connections.ts`, and the api would pull every module into them.
 */

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

/** Rows one batch of a walk reads; each may cost several crypto operations. */
const REENCRYPT_BATCH_SIZE = 50;

/** `ENVELOPE_COLUMNS` as the walk reads it; a column the schema does not have fails to compile here. */
const SCHEMA_COLUMNS: readonly SchemaColumn[] = ENVELOPE_COLUMNS;

/** Keyrings built so far in one request, so touching an account many times reads its keys once. */
const requestCiphers = new WeakMap<
  QueryCtx | MutationCtx,
  Map<Id<"accounts">, AccountCipher>
>();

/** The continuation arguments of a walk; a first call passes neither. */
export const reencryptWalkArgs = {
  table: v.optional(
    v.union(...ENVELOPE_TABLES.map((table) => v.literal(table))),
  ),
  cursor: v.optional(v.union(v.string(), v.null())),
};

/** A listed column with its three field names checked against the table's schema. */
type SchemaColumn = {
  [T in EnvelopeTable]: {
    table: T;
    scope: BlobScope;
    ciphertext: keyof Doc<T>;
    iv: keyof Doc<T>;
    tag: keyof Doc<T>;
  };
}[EnvelopeTable];

/**
 * A read-only keyring: decrypts every key the account holds, encrypts only
 * once a key exists. Built once per request and reused from then on.
 */
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

/** The keyring for a write: mints the account's first key when it has none. */
export async function accountCipherForWrite(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<AccountCipher> {
  const cipher = await accountCipher(ctx, accountId);
  if (cipher.keyId !== null) return cipher;
  await mintKey(ctx, accountId);

  return await accountCipher(ctx, accountId);
}

/**
 * Refuses blobs sealed outside this mutation, by an HTTP action, under a key
 * that is no longer the account's current one. A rotation that ran in between
 * would retire that key and strand the row; the caller retries and seals
 * under the new key.
 */
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

/** A keyring over `keys` under this deployment's secrets, legacy blobs included. */
export function cipherFromKeys(
  accountId: Id<"accounts">,
  keys: WrappedAccountKey[],
): AccountCipher {
  return new AccountCipher(accountId, encryptionSecrets(), keys, {
    rawSecret: process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET,
  });
}

/**
 * `ACCOUNT_CONFIG_ENCRYPTION_SECRET` as a list, split the way core's
 * `requireSecretsEnv` does: comma-separated, first wraps, every entry unwraps.
 */
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

/**
 * The account's keys, minting the first one when there is none. Actions call
 * this through `internal.account.keys.ensure` since they have no `ctx.db`.
 */
export async function ensureWrappedKeys(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<WrappedAccountKey[]> {
  const keys = await listWrappedKeys(ctx, accountId);
  if (keys.some((key) => key.retiredAt === undefined)) return keys;

  return [...keys, await mintKey(ctx, accountId)];
}

/** True when the deployment holds an encryption secret at all. */
export function hasEncryptionSecret(): boolean {
  return Boolean(process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET);
}

/** The account's keys as the codec sees them, oldest first. */
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

/** Stores a fresh key for the account; every keyring built from here on seals under it. */
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

/**
 * One batch of a walk over every encrypted table: each row whose blob is not
 * under its account's current key is decrypted and written back under it, so
 * the same walk serves the legacy migration and a key rotation. With
 * `accountId` only that account's rows are rewritten; the table is still paged
 * in full since two of them have no account index. A blob that does not
 * decrypt throws, so a bad secret stops the walk instead of skipping rows.
 * A row whose project has no account yet cannot be rewritten and is counted.
 * @returns rows rewritten, rows skipped, and the arguments of the next batch or null once the last table is done
 */
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
    // `SCHEMA_COLUMNS` proves the patched fields exist on the table; the
    // row type of a table chosen at runtime cannot express that.
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

/** The account id that owns the project; a retryable error where a caller needs one to encrypt and it is not provisioned yet. */
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

/** The account a row belongs to; env vars and runtime secrets reach it through their project. */
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

/** The patch that brings every blob on `row` under the cipher's current key, or null when none needs it. */
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
