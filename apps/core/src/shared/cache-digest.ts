import { createHmac, randomBytes } from "node:crypto";

// Per-process, so a leaked cache key cannot be matched offline against guessed credentials.
const PROCESS_CACHE_KEY = randomBytes(32);

export function cacheDigest(value: string): string {
  return createHmac("sha256", PROCESS_CACHE_KEY).update(value).digest("hex");
}
