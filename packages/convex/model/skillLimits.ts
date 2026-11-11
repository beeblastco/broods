// No imports: the CLI bundles this file without the Convex runtime.

export const MAX_CONFIGURED_SKILLS = 32;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
// Inline skill files reach one Node action base64; its arguments fail above about 6 MiB of JSON
// (4.49 MiB of raw files on the self-hosted backend), so the CLI uploads skills past this budget.
export const MAX_CLI_SKILL_SYNC_BYTES = 4 * 1024 * 1024;
