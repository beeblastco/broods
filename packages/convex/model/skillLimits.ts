// No imports: the CLI bundles this file without the Convex runtime.

export const MAX_CONFIGURED_SKILLS = 32;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
// The CLI sends every skill's files base64 in one request and one Convex action's arguments,
// capped at 16 MiB, which holds 12 MiB raw. This leaves room for the rest of the manifest.
export const MAX_CLI_SKILL_SYNC_BYTES = 10 * 1024 * 1024;
