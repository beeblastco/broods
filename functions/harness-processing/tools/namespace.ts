/**
 * Tool namespace helpers.
 * Keep conversation-key normalization shared across harness tools here.
 */

export function normalizeMemoryNamespace(conversationKey: string): string {
  return conversationKey
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "default";
}
