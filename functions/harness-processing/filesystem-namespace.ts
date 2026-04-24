/**
 * Filesystem namespace helpers for harness-processing.
 * Keep hashed namespace and lease-key derivation here.
 */

import { createHash } from "node:crypto";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;
export const INTERNAL_EVENT_ID_PREFIX = "conversation-lease:";

export function normalizeFilesystemNamespace(conversationKey: string): string {
  return `${FILESYSTEM_NAMESPACE_PREFIX}${hashScopedValue("filesystem-namespace", conversationKey)}`;
}

export function conversationLeaseKey(conversationKey: string): string {
  return `${INTERNAL_EVENT_ID_PREFIX}${hashScopedValue("conversation-lease", conversationKey)}`;
}

function hashScopedValue(scope: string, value: string): string {
  return createHash("sha256")
    .update(scope)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, HASH_HEX_LENGTH);
}
