/**
 * Cloudflare R2 temporary credentials, signed locally from a parent R2 token
 * the way Cloudflare documents it (r2/api/s3/temporary-credentials): an HS256
 * JWT keyed by the parent secret becomes the session token. No Cloudflare API
 * call. Web Crypto only, so it runs in the default Convex runtime. The parent
 * secret never leaves Convex; only the scoped result does.
 */

import { sha256Hex } from "./accountSecrets";
import { bytesToBase64Url } from "./stageSessionTicket";
import { r2AccountId } from "./workspaceRules";

const ENCODER = new TextEncoder();
// Matches the STS session core and Convex mint for an assumeRole bucket.
const R2_CREDENTIAL_TTL_SECONDS = 3600;

export interface R2Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** RFC3339 expiry. */
  expiration: string;
}

/**
 * Mint one-hour read/write credentials for `bucket`, limited to keys under
 * `prefix`. Used by `workspace.configs.r2Credentials` once it has checked
 * ownership and resolved the parent keys.
 * @throws when the endpoint is not an R2 endpoint or the prefix is not a folder
 */
export async function createR2Credentials(params: {
  endpoint: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
}): Promise<R2Credentials> {
  const accountId = r2AccountId(params.endpoint);
  if (!accountId) throw new Error("R2 credentials need an R2 endpoint");
  if (!params.prefix || !params.prefix.endsWith("/")) {
    throw new Error('R2 credential prefix must be non-empty and end with "/"');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + R2_CREDENTIAL_TTL_SECONDS;
  const header = encodeSegment({ alg: "HS256", typ: "JWT" });
  const payload = encodeSegment({
    bucket: params.bucket,
    scope: "object-read-write",
    paths: { prefixPaths: [params.prefix], objectPaths: [] },
    sub: accountId,
    iss: params.accessKeyId,
    aud: new URL(params.endpoint).host,
    iat: issuedAt,
    exp: expiresAt,
  });
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(params.secretAccessKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    ENCODER.encode(`${header}.${payload}`),
  );
  const jwt = `${header}.${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;

  return {
    accessKeyId: params.accessKeyId,
    secretAccessKey: await sha256Hex(jwt),
    sessionToken: btoa(`jwt/${jwt}`),
    expiration: new Date(expiresAt * 1000).toISOString(),
  };
}

function encodeSegment(value: Record<string, unknown>): string {
  return bytesToBase64Url(ENCODER.encode(JSON.stringify(value)));
}
