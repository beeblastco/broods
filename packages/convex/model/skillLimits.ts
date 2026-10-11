/**
 * How many skills an agent may list, the one number the config plane, core
 * and the CLI read. No imports on purpose: the CLI bundles this file without
 * the Convex runtime behind skillRules (like workspaceIsolation.ts).
 */

/** Distinct skills one agent may list in `config.skills.allowed`. */
export const MAX_CONFIGURED_SKILLS = 32;
