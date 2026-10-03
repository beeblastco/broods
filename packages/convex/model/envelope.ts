/**
 * Envelope encryption for account secrets, the one codec core and the config
 * plane share. Every account owns a data encryption key (DEK) stored wrapped
 * under the key encryption key (KEK) derived from
 * `ACCOUNT_CONFIG_ENCRYPTION_SECRET`. A row's blob is AES-256-GCM under the
 * DEK with `${accountId}:${table}:${field}` as additional data, so a
 * ciphertext cannot be moved to another tenant, row kind or column.
 *
 * Web Crypto only: Convex mutations run in a V8 isolate without `node:crypto`,
 * and core (Bun) has the same API. Key rows live in `accountKeys`; the Convex
 * side reads them in `./accountKeys.ts`, core caches them in
 * `apps/core/src/shared/convex/account-keys.ts`.
 */

import { hexFromBytes, sha256Hex } from "./accountSecrets";
import { isPlainObject } from "./objects";

/** Marks a blob encrypted under an account key; anything else is legacy. */
const BLOB_VERSION_PREFIX = "v2:";
const DEK_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_ID_BYTES = 6;
const KEK_ID_HEX_LENGTH = 8;

/**
 * Every encrypted column. The scope type, the table list and the
 * re-encryption walk all derive from this one list, so nothing can be
 * encrypted under a scope that a migration or rotation does not rewrite.
 * `scope` is what binds a blob to its column through the GCM additional data.
 */
export const ENVELOPE_COLUMNS = [
  {
    table: "agents",
    scope: "agents:encryptedConfig",
    ciphertext: "encryptedConfig",
    iv: "encryptionIv",
    tag: "encryptionTag",
  },
  {
    table: "agents",
    scope: "agents:encryptedSourceConfig",
    ciphertext: "encryptedSourceConfig",
    iv: "sourceEncryptionIv",
    tag: "sourceEncryptionTag",
  },
  {
    table: "sandboxConfigs",
    scope: "sandboxConfigs:encryptedConfig",
    ciphertext: "encryptedConfig",
    iv: "encryptionIv",
    tag: "encryptionTag",
  },
  {
    table: "sandboxConfigs",
    scope: "sandboxConfigs:encryptedSourceConfig",
    ciphertext: "encryptedSourceConfig",
    iv: "sourceEncryptionIv",
    tag: "sourceEncryptionTag",
  },
  {
    table: "environmentVariables",
    scope: "environmentVariables:ciphertext",
    ciphertext: "ciphertext",
    iv: "iv",
    tag: "tag",
  },
  {
    table: "accountEnvVars",
    scope: "accountEnvVars:ciphertext",
    ciphertext: "ciphertext",
    iv: "iv",
    tag: "tag",
  },
  {
    table: "agentRuntimeSecrets",
    scope: "agentRuntimeSecrets:ciphertext",
    ciphertext: "ciphertext",
    iv: "iv",
    tag: "tag",
  },
  {
    table: "agentDeployments",
    scope: "agentDeployments:apiKeyCiphertext",
    ciphertext: "apiKeyCiphertext",
    iv: "apiKeyIv",
    tag: "apiKeyTag",
  },
  {
    table: "channelEndpoints",
    scope: "channelEndpoints:tokenCiphertext",
    ciphertext: "tokenCiphertext",
    iv: "tokenIv",
    tag: "tokenTag",
  },
  {
    table: "connections",
    scope: "connections:ciphertext",
    ciphertext: "ciphertext",
    iv: "iv",
    tag: "tag",
  },
] as const;

/** Every table with an encrypted column, in the order a full walk visits them. */
export const ENVELOPE_TABLES = [
  ...new Set(ENVELOPE_COLUMNS.map((column) => column.table)),
];

/**
 * The three columns every encrypted row stores. `ciphertext` reads
 * `v2:<keyId>:<base64url>`; a bare base64url value is a legacy blob under the
 * old global key.
 */
export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

/** An `accountKeys` row without Convex system fields. */
export interface WrappedAccountKey {
  keyId: string;
  kekId: string;
  /** `<iv>.<ciphertext+tag>` base64url, AES-GCM under the KEK `kekId` names. */
  wrappedKey: string;
  retiredAt?: number;
}

export type EnvelopeColumn = (typeof ENVELOPE_COLUMNS)[number];

export type EnvelopeTable = EnvelopeColumn["table"];

/** `table:field` of the column a blob is bound to through the GCM additional data. */
export type BlobScope = EnvelopeColumn["scope"];

/** One unwrapped DEK, imported once for each use it has. */
interface DataKey {
  aes: CryptoKey;
  hmac: CryptoKey;
}

/**
 * One account's keyring for one request: encrypts under the newest live key,
 * decrypts whatever key a blob names, and never caches past its own lifetime.
 * Build it through `accountCipher*` on the Convex side or `accountCipherFor`
 * in core; the constructor only wires a wrapped key list to the KEK secrets.
 */
export class AccountCipher {
  private readonly accountId: string;
  private readonly secrets: string[];
  private readonly legacySecrets: string[];
  private readonly keys: Map<string, WrappedAccountKey>;
  private readonly currentKeyId: string | null;
  private readonly dataKeys = new Map<string, Promise<DataKey>>();

  /**
   * @param rawSecret the env value before it was split into `secrets`. Legacy
   * blobs were keyed by that whole string, so one holding a comma or outer
   * whitespace only opens under it.
   */
  constructor(
    accountId: string,
    secrets: string[],
    keys: WrappedAccountKey[],
    rawSecret?: string,
  ) {
    this.accountId = accountId;
    this.secrets = secrets;
    this.legacySecrets =
      rawSecret === undefined || secrets.includes(rawSecret)
        ? secrets
        : [...secrets, rawSecret];
    this.keys = new Map(keys.map((key) => [key.keyId, key]));
    // The newest key that is not retired seals new blobs.
    this.currentKeyId =
      keys.filter((key) => key.retiredAt === undefined).at(-1)?.keyId ?? null;
  }

  /** The key id new blobs are written under, or null when the account has none yet. */
  get keyId(): string | null {
    return this.currentKeyId;
  }

  /** HMAC-SHA256 hex of `value` under the current key, so a stored digest cannot be guessed offline. */
  async digest(value: string): Promise<string> {
    const { hmac } = await this.dataKey(this.requireCurrentKeyId());
    const mac = await crypto.subtle.sign(
      "HMAC",
      hmac,
      new TextEncoder().encode(value),
    );

    return hexFromBytes(new Uint8Array(mac));
  }

  /**
   * Decrypts a blob bound to `scope`. Null on any failure: unknown or retired
   * key, wrong tenant or column, tampered bytes, or a legacy blob under a
   * secret no longer in the list.
   */
  async decrypt(
    scope: BlobScope,
    blob: EncryptedBlob,
  ): Promise<Record<string, unknown> | null> {
    const keyId = blobKeyId(blob);
    try {
      const plaintext =
        keyId === null
          ? await decryptLegacyBlob(this.legacySecrets, blob)
          : await this.decryptEnvelope(keyId, scope, blob);
      const parsed: unknown = JSON.parse(plaintext);

      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Encrypts `value` under the current key, bound to `scope`. */
  async encrypt(
    scope: BlobScope,
    value: Record<string, unknown>,
  ): Promise<EncryptedBlob> {
    const keyId = this.requireCurrentKeyId();
    const { aes } = await this.dataKey(keyId);
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
          additionalData: new TextEncoder().encode(this.aad(scope)),
        },
        aes,
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    );
    const split = sealed.length - GCM_TAG_BYTES;

    return {
      ciphertext: `${BLOB_VERSION_PREFIX}${keyId}:${bytesToBase64Url(sealed.subarray(0, split))}`,
      iv: bytesToBase64Url(iv),
      tag: bytesToBase64Url(sealed.subarray(split)),
    };
  }

  /** True when this keyring holds the key a blob names (retired included), or the blob is legacy. */
  hasKey(blob: EncryptedBlob): boolean {
    const keyId = blobKeyId(blob);

    return keyId === null || this.keys.has(keyId);
  }

  /** True when `blob` was not written under the current key, so a rotation or migration must rewrite it. */
  needsRewrite(blob: Pick<EncryptedBlob, "ciphertext">): boolean {
    return blobKeyId(blob) !== this.currentKeyId;
  }

  private aad(scope: BlobScope): string {
    return `${this.accountId}:${scope}`;
  }

  /** The key `keyId` names, unwrapped and imported once per keyring. A retired key opens nothing. */
  private dataKey(keyId: string): Promise<DataKey> {
    const cached = this.dataKeys.get(keyId);
    if (cached) return cached;
    const wrapped = this.keys.get(keyId);
    if (!wrapped) throw new Error(`Unknown account key ${keyId}`);
    if (wrapped.retiredAt !== undefined) {
      throw new Error(`Account key ${keyId} is retired`);
    }
    const dataKey = unwrapAccountKey(
      this.accountId,
      this.secrets,
      wrapped,
    ).then(importDataKey);
    this.dataKeys.set(keyId, dataKey);

    return dataKey;
  }

  private async decryptEnvelope(
    keyId: string,
    scope: BlobScope,
    blob: EncryptedBlob,
  ): Promise<string> {
    const { aes } = await this.dataKey(keyId);
    const sealed = concatBytes(
      base64UrlToBytes(
        blob.ciphertext.slice(BLOB_VERSION_PREFIX.length + keyId.length + 1),
      ),
      base64UrlToBytes(blob.tag),
    );
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(base64UrlToBytes(blob.iv)),
        additionalData: new TextEncoder().encode(this.aad(scope)),
      },
      aes,
      toArrayBuffer(sealed),
    );

    return new TextDecoder().decode(plaintext);
  }

  private requireCurrentKeyId(): string {
    if (this.currentKeyId === null) {
      throw new Error(`Account ${this.accountId} has no live encryption key`);
    }

    return this.currentKeyId;
  }
}

/** The key id a blob names, or null for a legacy blob under the old global key. */
export function blobKeyId(
  blob: Pick<EncryptedBlob, "ciphertext">,
): string | null {
  if (!blob.ciphertext.startsWith(BLOB_VERSION_PREFIX)) return null;
  const end = blob.ciphertext.indexOf(":", BLOB_VERSION_PREFIX.length);

  return end === -1
    ? null
    : blob.ciphertext.slice(BLOB_VERSION_PREFIX.length, end);
}

/** A fresh random DEK wrapped under the first secret, the one that seals. */
export async function createWrappedAccountKey(
  accountId: string,
  secrets: string[],
): Promise<WrappedAccountKey> {
  const keyId = hexFromBytes(
    crypto.getRandomValues(new Uint8Array(KEY_ID_BYTES)),
  );
  const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));

  return await wrapAccountKey(accountId, secrets, keyId, dek);
}

/** The id of the KEK a secret derives, as stored on `accountKeys.kekId`. */
export async function kekIdOf(secret: string): Promise<string> {
  return (await sha256Hex(secret)).slice(0, KEK_ID_HEX_LENGTH);
}

/** The columns to patch so the key's DEK sits under the first secret, or null when it already does. */
export async function rewrapAccountKey(
  accountId: string,
  secrets: string[],
  wrapped: WrappedAccountKey,
): Promise<Pick<WrappedAccountKey, "kekId" | "wrappedKey"> | null> {
  if (wrapped.kekId === (await kekIdOf(secrets[0]!))) return null;
  const dek = await unwrapAccountKey(accountId, secrets, wrapped);
  const next = await wrapAccountKey(accountId, secrets, wrapped.keyId, dek);

  return { kekId: next.kekId, wrappedKey: next.wrappedKey };
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);

  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);

  return out;
}

// legacy until migrateToEnvelope has run: a blob with no `v2:` prefix is
// AES-256-GCM under SHA-256(secret) with no additional data. Every listed
// secret is tried so a KEK rotation does not strand rows the migration has
// not reached yet.
async function decryptLegacyBlob(
  secrets: string[],
  blob: EncryptedBlob,
): Promise<string> {
  const sealed = toArrayBuffer(
    concatBytes(base64UrlToBytes(blob.ciphertext), base64UrlToBytes(blob.tag)),
  );
  const iv = toArrayBuffer(base64UrlToBytes(blob.iv));
  for (const secret of secrets) {
    const key = await importAesKey(new Uint8Array(await sha256(secret)), [
      "decrypt",
    ]);
    try {
      return new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, sealed),
      );
    } catch {
      continue;
    }
  }

  throw new Error("Legacy blob does not decrypt under any listed secret");
}

function importAesKey(
  bytes: Uint8Array,
  usages: Array<"encrypt" | "decrypt">,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(bytes),
    { name: "AES-GCM" },
    false,
    usages,
  );
}

async function importDataKey(dek: Uint8Array): Promise<DataKey> {
  return {
    aes: await importAesKey(dek, ["encrypt", "decrypt"]),
    hmac: await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(dek),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    ),
  };
}

/** The KEK is a domain-separated hash of the secret, so it never equals the legacy blob key. */
async function keyEncryptionKey(secret: string): Promise<CryptoKey> {
  return await importAesKey(
    new Uint8Array(await sha256(`broods-kek:${secret}`)),
    ["encrypt", "decrypt"],
  );
}

function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

// A copy, since a view's `.buffer` may be a SharedArrayBuffer to the type system.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);

  return buffer;
}

async function unwrapAccountKey(
  accountId: string,
  secrets: string[],
  wrapped: WrappedAccountKey,
): Promise<Uint8Array> {
  for (const secret of secrets) {
    if ((await kekIdOf(secret)) !== wrapped.kekId) continue;
    const [iv, sealed] = wrapped.wrappedKey.split(".");
    if (!iv || !sealed) throw new Error("Malformed wrapped account key");

    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(base64UrlToBytes(iv)),
          additionalData: new TextEncoder().encode(
            wrapAad(accountId, wrapped.keyId),
          ),
        },
        await keyEncryptionKey(secret),
        toArrayBuffer(base64UrlToBytes(sealed)),
      ),
    );
  }

  throw new Error(
    `No ACCOUNT_CONFIG_ENCRYPTION_SECRET entry derives KEK ${wrapped.kekId}`,
  );
}

function wrapAad(accountId: string, keyId: string): string {
  return `${accountId}:${keyId}`;
}

async function wrapAccountKey(
  accountId: string,
  secrets: string[],
  keyId: string,
  dek: Uint8Array,
): Promise<WrappedAccountKey> {
  const secret = secrets[0]!;
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
        additionalData: new TextEncoder().encode(wrapAad(accountId, keyId)),
      },
      await keyEncryptionKey(secret),
      toArrayBuffer(dek),
    ),
  );

  return {
    keyId: keyId,
    kekId: await kekIdOf(secret),
    wrappedKey: `${bytesToBase64Url(iv)}.${bytesToBase64Url(sealed)}`,
  };
}
