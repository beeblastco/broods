/**
 * The Convex side of envelope encryption: builds an `AccountCipher` from the
 * account's `accountKeys` rows, mints the first key on the first write, and
 * walks every encrypted table so a migration or a rotation can rewrite blobs
 * in bounded batches. The codec itself is `./envelope.ts`; the internal
 * functions that expose this live in `account/keys.ts` and `migrations.ts`.
 */

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { accountIdForProject } from "./auditEvents";
import {
  AccountCipher,
  type BlobScope,
  createWrappedAccountKey,
  type EncryptedBlob,
  parseEncryptionSecrets,
  type WrappedAccountKey,
} from "./envelope";

/** Every table with an envelope-encrypted column, in the order a full walk visits them. */
export const ENVELOPE_TABLES = [
  "agents",
  "sandboxConfigs",
  "environmentVariables",
  "accountEnvVars",
  "agentRuntimeSecrets",
  "agentDeployments",
  "channelEndpoints",
  "connections",
] as const;

export type EnvelopeTable = (typeof ENVELOPE_TABLES)[number];

/** Rows one batch of a walk reads; each may cost several crypto operations. */
const REENCRYPT_BATCH_SIZE = 50;

/** The column triple holding one blob, and the scope it is bound to. */
interface BlobColumns {
  ciphertext: string;
  iv: string;
  tag: string;
  scope: BlobScope;
}

const BLOB_COLUMNS: Record<EnvelopeTable, BlobColumns[]> = {
  accountEnvVars: [
    {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      scope: "accountEnvVars:ciphertext",
    },
  ],
  agentDeployments: [
    {
      ciphertext: "apiKeyCiphertext",
      iv: "apiKeyIv",
      tag: "apiKeyTag",
      scope: "agentDeployments:apiKeyCiphertext",
    },
  ],
  agentRuntimeSecrets: [
    {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      scope: "agentRuntimeSecrets:ciphertext",
    },
  ],
  agents: [
    {
      ciphertext: "encryptedConfig",
      iv: "encryptionIv",
      tag: "encryptionTag",
      scope: "agents:encryptedConfig",
    },
    {
      ciphertext: "encryptedSourceConfig",
      iv: "sourceEncryptionIv",
      tag: "sourceEncryptionTag",
      scope: "agents:encryptedSourceConfig",
    },
  ],
  channelEndpoints: [
    {
      ciphertext: "tokenCiphertext",
      iv: "tokenIv",
      tag: "tokenTag",
      scope: "channelEndpoints:tokenCiphertext",
    },
  ],
  connections: [
    {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      scope: "connections:ciphertext",
    },
  ],
  environmentVariables: [
    {
      ciphertext: "ciphertext",
      iv: "iv",
      tag: "tag",
      scope: "environmentVariables:ciphertext",
    },
  ],
  sandboxConfigs: [
    {
      ciphertext: "encryptedConfig",
      iv: "encryptionIv",
      tag: "encryptionTag",
      scope: "sandboxConfigs:encryptedConfig",
    },
    {
      ciphertext: "encryptedSourceConfig",
      iv: "sourceEncryptionIv",
      tag: "sourceEncryptionTag",
      scope: "sandboxConfigs:encryptedSourceConfig",
    },
  ],
};

/** A read-only keyring: decrypts every key the account holds, encrypts only once a key exists. */
export async function accountCipher(
  ctx: QueryCtx | MutationCtx,
  accountId: Id<"accounts">,
): Promise<AccountCipher> {
  return new AccountCipher(
    accountId,
    encryptionSecrets(),
    await listWrappedKeys(ctx, accountId),
  );
}

/**
 * The keyring from an HTTP action, which has no `ctx.db`: one mutation call
 * fetches the keys and mints the first when the account has none. Build it
 * once per request and pass it down, not once per row.
 */
export async function accountCipherForAction(
  ctx: ActionCtx,
  accountId: Id<"accounts">,
): Promise<AccountCipher> {
  const keys: WrappedAccountKey[] = await ctx.runMutation(
    internal.account.keys.ensure,
    { accountId: accountId },
  );

  return new AccountCipher(accountId, encryptionSecrets(), keys);
}

/** The keyring for a write: mints the account's first key when it has none. */
export async function accountCipherForWrite(
  ctx: MutationCtx,
  accountId: Id<"accounts">,
): Promise<AccountCipher> {
  return new AccountCipher(
    accountId,
    encryptionSecrets(),
    await ensureWrappedKeys(ctx, accountId),
  );
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
  const created = await createWrappedAccountKey(accountId, encryptionSecrets());
  await ctx.db.insert("accountKeys", {
    ...created,
    accountId: accountId,
    createdAt: Date.now(),
  });

  return [...keys, created];
}

/** `ACCOUNT_CONFIG_ENCRYPTION_SECRET` as a list: first wraps, all unwrap. */
export function encryptionSecrets(): string[] {
  return parseEncryptionSecrets(process.env.ACCOUNT_CONFIG_ENCRYPTION_SECRET);
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

  return rows.map(wrappedKeyOf);
}

/**
 * One batch of a walk over `table`: every row whose blob is not under its
 * account's current key is decrypted and written back under it, so the same
 * walk serves the legacy migration and a key rotation. With `accountId` only
 * that account's rows are rewritten; the table is still paged in full since
 * two of them have no account index. A blob that does not decrypt throws, so
 * a bad secret stops the walk instead of skipping rows.
 */
export async function reencryptBatch(
  ctx: MutationCtx,
  args: {
    table: EnvelopeTable;
    cursor: string | null;
    accountId?: Id<"accounts">;
  },
): Promise<{ patched: number; isDone: boolean; continueCursor: string }> {
  const page = await ctx.db
    .query(args.table)
    .paginate({ numItems: REENCRYPT_BATCH_SIZE, cursor: args.cursor });
  const ciphers = new Map<Id<"accounts">, AccountCipher>();
  let patched = 0;
  for (const row of page.page) {
    const accountId = await accountIdForRow(ctx, row);
    if (!accountId || (args.accountId && accountId !== args.accountId)) {
      continue;
    }
    let cipher = ciphers.get(accountId);
    if (!cipher) {
      cipher = await accountCipherForWrite(ctx, accountId);
      ciphers.set(accountId, cipher);
    }
    const patch = await reencryptRow(args.table, row, cipher);
    if (!patch) continue;
    // The column names come from the static table map above, which is what
    // keeps the patch sound; the generic row type cannot express that.
    await ctx.db.patch(row._id, patch as Partial<Doc<EnvelopeTable>>);
    patched += 1;
  }

  return {
    patched: patched,
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
}

/** The account id that owns the project, throwing where a caller needs one to encrypt. */
export async function requireAccountIdForProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
): Promise<Id<"accounts">> {
  const accountId = await accountIdForProject(ctx, projectId);
  if (!accountId) {
    throw new Error("Project has no provisioned account to encrypt under");
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

/** The patch that brings every blob on `row` under the cipher's current key, or null when none needs it. */
async function reencryptRow(
  table: EnvelopeTable,
  row: Doc<EnvelopeTable>,
  cipher: AccountCipher,
): Promise<Record<string, string> | null> {
  const columns: Record<string, unknown> = row;
  const patch: Record<string, string> = {};
  for (const column of BLOB_COLUMNS[table]) {
    const blob = blobAt(columns, column);
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

function blobAt(
  row: Record<string, unknown>,
  column: BlobColumns,
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

function wrappedKeyOf(row: Doc<"accountKeys">): WrappedAccountKey {
  return {
    keyId: row.keyId,
    kekId: row.kekId,
    wrappedKey: row.wrappedKey,
    ...(row.retiredAt !== undefined ? { retiredAt: row.retiredAt } : {}),
  };
}
