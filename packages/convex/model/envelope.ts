import { hexFromBytes, sha256Hex } from "./accountSecrets";
import { isPlainObject } from "./objects";

const BLOB_VERSION_PREFIX = "v2:";
const DEK_BYTES = 32;
const GCM_IV_BYTES = 12;
export const GCM_TAG_BYTES = 16;
const KEY_ID_BYTES = 6;
const KEK_ID_HEX_LENGTH = 8;
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();

// Scopes, tables and the rotation walk derive from this list, so a rotation rewrites every scope.
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
    table: "agentDeployments",
    scope: "agentDeployments:userTokenSecretCiphertext",
    ciphertext: "userTokenSecretCiphertext",
    iv: "userTokenSecretIv",
    tag: "userTokenSecretTag",
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

export const ENVELOPE_TABLES = [
  ...new Set(ENVELOPE_COLUMNS.map((column) => column.table)),
];

const WEB_AES_KEYS = new WeakMap<Uint8Array, Promise<CryptoKey>>();
const WEB_HMAC_KEYS = new WeakMap<Uint8Array, Promise<CryptoKey>>();

// The default: a Convex isolate has no `node:crypto`. Core passes a synchronous one.
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

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface WrappedAccountKey {
  keyId: string;
  kekId: string;
  wrappedKey: string;
  retiredAt?: number;
}

type EnvelopeColumn = (typeof ENVELOPE_COLUMNS)[number];

export type EnvelopeTable = EnvelopeColumn["table"];

export type BlobScope = EnvelopeColumn["scope"];

// HMAC-SHA256 and AES-256-GCM over raw 32-byte keys; `sealed` is `ciphertext || tag`.
export interface AeadPrimitive {
  hmac(key: Uint8Array, data: Uint8Array): Uint8Array | Promise<Uint8Array>;
  open(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    sealed: Uint8Array,
  ): Uint8Array | Promise<Uint8Array>;
  seal(
    key: Uint8Array,
    iv: Uint8Array,
    aad: Uint8Array,
    plaintext: Uint8Array,
  ): Uint8Array | Promise<Uint8Array>;
}

// One account's keyring for one request: it caches unwrapped keys, so never hold it longer.
export class AccountCipher {
  private readonly accountId: string;
  private readonly secrets: string[];
  private readonly keys: Map<string, WrappedAccountKey>;
  private readonly currentKeyId: string | null;
  private readonly primitive: AeadPrimitive;
  private readonly dataKeys = new Map<string, Promise<Uint8Array>>();

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
    // Rows come in creation order, so the last live key is the newest.
    this.currentKeyId =
      keys.findLast((key) => key.retiredAt === undefined)?.keyId ?? null;
  }

  get keyId(): string | null {
    return this.currentKeyId;
  }

  // Keyed, so a stored digest cannot be guessed offline.
  async digest(value: string): Promise<string> {
    const mac = await this.primitive.hmac(
      await this.dataKey(this.requireCurrentKeyId()),
      TEXT_ENCODER.encode(value),
    );

    return hexFromBytes(mac);
  }

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

  hasKey(blob: Pick<EncryptedBlob, "ciphertext">): boolean {
    const keyId = blobKeyId(blob);

    return keyId !== null && this.keys.has(keyId);
  }

  needsRewrite(blob: Pick<EncryptedBlob, "ciphertext">): boolean {
    return blobKeyId(blob) !== this.currentKeyId;
  }

  // GCM additional data: a ciphertext cannot be moved to another tenant or column.
  private aad(scope: BlobScope): string {
    return `${this.accountId}:${scope}`;
  }

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

export async function kekIdOf(secret: string): Promise<string> {
  return (await sha256Hex(secret)).slice(0, KEK_ID_HEX_LENGTH);
}

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

function blobKeyId(blob: Pick<EncryptedBlob, "ciphertext">): string | null {
  if (!blob.ciphertext.startsWith(BLOB_VERSION_PREFIX)) return null;
  const end = blob.ciphertext.indexOf(":", BLOB_VERSION_PREFIX.length);

  return end === -1
    ? null
    : blob.ciphertext.slice(BLOB_VERSION_PREFIX.length, end);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  // Native where it exists: building the string by hand costs several times the cipher.
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
