// The stream sequence is shared by every tenant, so a client holding raw sequences could watch
// the gaps and read other tenants' traffic rate. Clients get the sequence encrypted instead.
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import type { CredentialScope } from "./upstream.ts";

const BLOCK_BYTES = 16;
const ALGORITHM = "aes-128-ecb";

/** One key per stage, so a cursor issued to one tenant opens to nothing for another. */
export function cursorKey(
  secret: string,
  scope: Pick<CredentialScope, "accountId" | "projectSlug" | "stageSlug">,
): Buffer {
  return createHmac("sha256", secret)
    .update(
      `observability-cursor\0${scope.accountId}\0${scope.projectSlug}\0${scope.stageSlug}`,
    )
    .digest()
    .subarray(0, BLOCK_BYTES);
}

/** The sequence a client's cursor names, or undefined for one this key did not seal. */
export function openCursor(key: Buffer, cursor: string): number | undefined {
  const sealed = Buffer.from(cursor, "base64url");
  if (sealed.length !== BLOCK_BYTES) return undefined;
  const decipher = createDecipheriv(ALGORITHM, key, null).setAutoPadding(false);
  const block = Buffer.concat([decipher.update(sealed), decipher.final()]);
  // The zero half is the check: a forged or foreign cursor decrypts to noise there.
  if (block.readBigUInt64BE(0) !== 0n) return undefined;
  const sequence = block.readBigUInt64BE(8);

  return sequence <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(sequence)
    : undefined;
}

export function sealCursor(key: Buffer, sequence: number): string {
  const block = Buffer.alloc(BLOCK_BYTES);
  block.writeBigUInt64BE(BigInt(sequence), 8);
  const cipher = createCipheriv(ALGORITHM, key, null).setAutoPadding(false);

  return Buffer.concat([cipher.update(block), cipher.final()]).toString(
    "base64url",
  );
}
