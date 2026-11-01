// Sync, so a per-turn decrypt skips the Web Crypto thread hop; blobs open with either primitive.

import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import {
  type AeadPrimitive,
  GCM_TAG_BYTES,
} from "@broods/convex/model/envelope";

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
