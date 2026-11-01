import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { hexFromBytes } from "./accountSecrets";
import { assertPublicHttpsUrl } from "./agentRules";
import { ClientError } from "./clientError";
import { isPlainObject } from "./objects";

export const AUDIT_SIGNATURE_HEADER = "X-Broods-Signature";
const ENCODER = new TextEncoder();
const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" };
const SECRET_MAX_LENGTH = 256;

export type AuditSinkInput = {
  url: string;
  secret: string;
};

export async function auditSinkRow(
  db: QueryCtx["db"],
  accountId: Id<"accounts">,
): Promise<Doc<"auditSinks"> | null> {
  return await db
    .query("auditSinks")
    .withIndex("by_accountId", (q) => q.eq("accountId", accountId))
    .unique();
}

export function normalizeAuditSinkInput(value: unknown): AuditSinkInput {
  if (!isPlainObject(value)) throw new ClientError("Body must be an object");
  const { url, secret } = value;
  if (typeof url !== "string" || url.trim() === "")
    throw new ClientError("url is required");
  assertPublicHttpsUrl(url.trim(), "url");
  if (typeof secret !== "string" || secret.trim() === "")
    throw new ClientError("secret is required");
  if (secret.length > SECRET_MAX_LENGTH)
    throw new ClientError(
      `secret must be at most ${SECRET_MAX_LENGTH} characters`,
    );

  return { url: url.trim(), secret: secret };
}

// Must match core's lifecycle webhook signature: a receiver verifies both with one routine.
export async function signAuditExport(
  secret: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(secret),
    HMAC_ALGORITHM,
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    HMAC_ALGORITHM,
    key,
    ENCODER.encode(body),
  );

  return `sha256=${hexFromBytes(new Uint8Array(signature))}`;
}
