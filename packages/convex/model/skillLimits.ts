// No imports: the CLI bundles this file without the Convex runtime.

export const MAX_CONFIGURED_SKILLS = 32;
export const MAX_SKILL_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 30 * 1024 * 1024;
// A sync passes every skill's files base64 to one Node action; its arguments fail above about
// 6 MiB of JSON, measured on the self-hosted backend as 4.49 MiB of raw skill files.
export const MAX_CLI_SKILL_SYNC_BYTES = 4 * 1024 * 1024;
