/**
 * The envelope codec's cipher on `node:crypto`. It is synchronous, so a
 * per-turn decrypt in core costs no Web Crypto thread hop. The blob format
 * stays in `@broods/convex/model/envelope`; this only seals and opens bytes,
 * and a blob sealed by either primitive opens with the other.
 */

import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import type { AeadPrimitive } from "@broods/convex/model/envelope";

const GCM_TAG_BYTES = 16;

export const NODE_CRYPTO: AeadPrimitive = {
  hmac: (key, data): Uint8Array =>
    createHmac("sha256", key).update(data).digest(),
  open: (key, iv, aad, sealed): Uint8Array => {
    const split = sealed.length - GCM_TAG_BYTES;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(split));

    return Buffer.concat([
      decipher.update(sealed.subarray(0, split)),
      decipher.final(),
    ]);
  },
  seal: (key, iv, aad, plaintext): Uint8Array => {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad);

    return Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
  },
};
