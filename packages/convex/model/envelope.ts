/**
 * Envelope encryption for account secrets, the one codec core and the config
 * plane share. Every account owns a data encryption key (DEK) stored wrapped
 * under the key encryption key (KEK) derived from
 * `ACCOUNT_CONFIG_ENCRYPTION_SECRET`. A row's blob is AES-256-GCM under the
 * DEK with `${accountId}:${table}:${field}` as additional data, so a
 * ciphertext cannot be moved to another tenant, row kind or column.
 *
 * Web Crypto by default: Convex mutations run in a V8 isolate without
 * `node:crypto`. The cipher itself is an `AeadPrimitive`, so core passes the
 * synchronous `node:crypto` one and keeps a per-turn decrypt off a thread hop;
 * the format, the additional data and the key ids stay in this one file.
 * Key rows live in `accountKeys`; the Convex side reads them in
 * `./accountKeys.ts`, core caches them in
 * `apps/core/src/shared/convex/account-keys.ts`.
 */

import { hexFromBytes, sha256Hex } from "./accountSecrets";
import { isPlainObject } from "./objects";

/** Marks a blob encrypted under an account key; anything else is refused. */
const BLOB_VERSION_PREFIX = "v2:";
const DEK_BYTES = 32;
const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
const KEY_ID_BYTES = 6;
const KEK_ID_HEX_LENGTH = 8;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

/**
 * Every encrypted column. The scope type, the table list and the
 * re-encryption walk all derive from this one list, so nothing can be
 * encrypted under a scope that a rotation does not rewrite.
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
  {
    table: "auditSinks",
    scope: "auditSinks:encryptedSecret",
    ciphertext: "encryptedSecret",
    iv: "secretIv",
    tag: "secretTag",
  },
] as const;

/** Every table with an encrypted column, in the order a full walk visits them. */
export const ENVELOPE_TABLES = [
  ...new Set(ENVELOPE_COLUMNS.map((column) => column.table)),
];

/** Keys Web Crypto has imported, remembered per key object so a keyring imports each once. */
const WEB_AES_KEYS = new WeakMap<Uint8Array, Promise<CryptoKey>>();
const WEB_HMAC_KEYS = new WeakMap<Uint8Array, Promise<CryptoKey>>();

/** Web Crypto, the only crypto a Convex isolate has. */
const WEB_CRYPTO: AeadPrimitive = {
  hmac: async (key, data): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await webKey(key, "hmac"),
        toArrayBuffer(data),
      ),
    ),
  open: async (key, iv, aad, sealed): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(iv),
          additionalData: toArrayBuffer(aad),
        },
        await webKey(key, "aes"),
        toArrayBuffer(sealed),
      ),
    ),
  seal: async (key, iv, aad, plaintext): Promise<Uint8Array> =>
    new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: toArrayBuffer(iv),
          additionalData: toArrayBuffer(aad),
        },
        await webKey(key, "aes"),
        toArrayBuffer(plaintext),
      ),
    ),
};

/**
 * The three columns every encrypted row stores. `ciphertext` reads
 * `v2:<keyId>:<base64url>`.
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

type EnvelopeColumn = (typeof ENVELOPE_COLUMNS)[number];

export type EnvelopeTable = EnvelopeColumn["table"];

/** `table:field` of the column a blob is bound to through the GCM additional data. */
export type BlobScope = EnvelopeColumn["scope"];

/**
 * The cipher and MAC the codec runs on, over raw 32-byte keys. An
 * implementation may answer synchronously; the codec awaits either way.
 */
export interface AeadPrimitive {
  /** HMAC-SHA256 of `data`. */
  hmac(key: Uint8Array, data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** AES-256-GCM open of `ciphertext || tag`; throws when the tag does not verify. */
  open(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    sealed: Uint8Array,
  ): Uint8Array | Promise<Uint8Array>;
  /** AES-256-GCM seal, answering `ciphertext || tag`. */
  seal(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array,
  ): Uint8Array | Promise<Uint8Array>;
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
  private readonly keys: Map<string, WrappedAccountKey>;
  private readonly currentKeyId: string | null;
  private readonly primitive: AeadPrimitive;
  private readonly dataKeys = new Map<string, Promise<Uint8Array>>();

  /** @param options.primitive the cipher to run on; Web Crypto when omitted. */
  constructor(
    accountId: string,
    secrets: string[],
    keys: WrappedAccountKey[],
    options: { primitive?: AeadPrimitive } = {},
  ) {
    this.accountId = accountId;
    this.secrets = secrets;
    this.primitive = options.primitive ?? WEB_CRYPTO;
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
    const mac = await this.primitive.hmac(
      await this.dataKey(this.requireCurrentKeyId()),
      TEXT_ENCODER.encode(value),
    );

    return hexFromBytes(mac);
  }

  /**
   * Decrypts a blob bound to `scope`. Null on any failure: a blob without
   * the `v2:` key id, unknown or retired key, wrong tenant or column, or
   * tampered bytes.
   */
  async decrypt(
    scope: BlobScope,
    blob: EncryptedBlob,
  ): Promise<Record<string, unknown> | null> {
    const keyId = blobKeyId(blob);
    if (keyId === null) return null;
    try {
      const plaintext = await this.decryptEnvelope(keyId, scope, blob);
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
    const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
    const sealed = await this.primitive.seal(
      await this.dataKey(keyId),
      iv,
      TEXT_ENCODER.encode(this.aad(scope)),
      TEXT_ENCODER.encode(JSON.stringify(value)),
    );
    const split = sealed.length - GCM_TAG_BYTES;

    return {
      ciphertext: `${BLOB_VERSION_PREFIX}${keyId}:${bytesToBase64Url(sealed.subarray(0, split))}`,
      iv: bytesToBase64Url(iv),
      tag: bytesToBase64Url(sealed.subarray(split)),
    };
  }

  /** True when this keyring holds the key a blob names, retired included. */
  hasKey(blob: Pick<EncryptedBlob, "ciphertext">): boolean {
    const keyId = blobKeyId(blob);

    return keyId !== null && this.keys.has(keyId);
  }

  /** True when `blob` was not written under the current key, so a rotation must rewrite it. */
  needsRewrite(blob: Pick<EncryptedBlob, "ciphertext">): boolean {
    return blobKeyId(blob) !== this.currentKeyId;
  }

  private aad(scope: BlobScope): string {
    return `${this.accountId}:${scope}`;
  }

  /** The key `keyId` names, unwrapped once per keyring. A retired key opens nothing. */
  private dataKey(keyId: string): Promise<Uint8Array> {
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
      this.primitive,
    );
    this.dataKeys.set(keyId, dataKey);

    return dataKey;
  }

  private async decryptEnvelope(
    keyId: string,
    scope: BlobScope,
    blob: EncryptedBlob,
  ): Promise<string> {
    const plaintext = await this.primitive.open(
      await this.dataKey(keyId),
      base64UrlToBytes(blob.iv),
      TEXT_ENCODER.encode(this.aad(scope)),
      concatBytes(
        base64UrlToBytes(
          blob.ciphertext.slice(BLOB_VERSION_PREFIX.length + keyId.length + 1),
        ),
        base64UrlToBytes(blob.tag),
      ),
    );

    return TEXT_DECODER.decode(plaintext);
  }

  private requireCurrentKeyId(): string {
    if (this.currentKeyId === null) {
      throw new Error(`Account ${this.accountId} has no live encryption key`);
    }

    return this.currentKeyId;
  }
}

/** The key id a blob names, or null when it carries no `v2:` key id. */
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
  const dek = await unwrapAccountKey(accountId, secrets, wrapped, WEB_CRYPTO);
  const next = await wrapAccountKey(accountId, secrets, wrapped.keyId, dek);

  return { kekId: next.kekId, wrappedKey: next.wrappedKey };
}

function base64UrlToBytes(value: string): Uint8Array {
  if (typeof Uint8Array.fromBase64 === "function") {
    return Uint8Array.fromBase64(value, { alphabet: "base64url" });
  }
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);

  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  // Native where the runtime has it: building the string by hand costs
  // several times the cipher itself.
  if (typeof bytes.toBase64 === "function") {
    return bytes.toBase64({ alphabet: "base64url", omitPadding: true });
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]!);

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

/** The KEK is a domain-separated hash of the secret. */
async function keyEncryptionKey(secret: string): Promise<Uint8Array> {
  return new Uint8Array(await sha256(`broods-kek:${secret}`));
}

function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value));
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
  primitive: AeadPrimitive,
): Promise<Uint8Array> {
  for (const secret of secrets) {
    if ((await kekIdOf(secret)) !== wrapped.kekId) continue;
    const [iv, sealed] = wrapped.wrappedKey.split(".");
    if (!iv || !sealed) throw new Error("Malformed wrapped account key");

    return await primitive.open(
      await keyEncryptionKey(secret),
      base64UrlToBytes(iv),
      TEXT_ENCODER.encode(wrapAad(accountId, wrapped.keyId)),
      base64UrlToBytes(sealed),
    );
  }

  throw new Error(
    `No ACCOUNT_CONFIG_ENCRYPTION_SECRET entry derives KEK ${wrapped.kekId}`,
  );
}

function webKey(key: Uint8Array, use: "aes" | "hmac"): Promise<CryptoKey> {
  const cache = use === "hmac" ? WEB_HMAC_KEYS : WEB_AES_KEYS;
  let imported = cache.get(key);
  if (!imported) {
    imported =
      use === "hmac"
        ? crypto.subtle.importKey(
            "raw",
            toArrayBuffer(key),
            { name: "HMAC", hash: "SHA-256" },
            false,
            ["sign"],
          )
        : crypto.subtle.importKey(
            "raw",
            toArrayBuffer(key),
            { name: "AES-GCM" },
            false,
            ["encrypt", "decrypt"],
          );
    cache.set(key, imported);
  }

  return imported;
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
  const sealed = await WEB_CRYPTO.seal(
    await keyEncryptionKey(secret),
    iv,
    TEXT_ENCODER.encode(wrapAad(accountId, keyId)),
    dek,
  );

  return {
    keyId: keyId,
    kekId: await kekIdOf(secret),
    wrappedKey: `${bytesToBase64Url(iv)}.${bytesToBase64Url(sealed)}`,
  };
}
