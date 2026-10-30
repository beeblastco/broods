/**
 * Digest for in-memory cache keys built from credential material. It is keyed
 * with a secret that exists only in this process, so a key that leaks (a heap
 * dump, a log line) cannot be matched offline against guessed credentials.
 * Not a stored hash: the keys differ per process and never leave it.
 */

import { createHmac, randomBytes } from "node:crypto";

// Drawn on first use: a V8 isolate (workerd) refuses random bytes at module scope.
let processCacheKey: Buffer | undefined;

/** The cache-key digest of `value`: the same value gives the same key for this process's lifetime. */
export function cacheDigest(value: string): string {
  processCacheKey ??= randomBytes(32);

  return createHmac("sha256", processCacheKey).update(value).digest("hex");
}
