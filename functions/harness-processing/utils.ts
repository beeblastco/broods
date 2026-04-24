/**
 * Generic utilities.
 * Keep small generic helpers here when they do not belong elsewhere.
 */

export function normalizeFilesystemNamespace(conversationKey: string): string {
    return conversationKey
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "") || "default";
}
