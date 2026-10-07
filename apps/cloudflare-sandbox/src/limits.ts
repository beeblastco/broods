/**
 * Per-call ceilings the bridge enforces. Core's cloudflare executor imports this
 * file to clamp its requests, so the two cannot drift.
 */

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_TIMEOUT_MS = 15 * 60 * 1000;
// `setInactivityTimeout` rejects more than six hours; the config plane holds
// cloudflare's `lifecycle.idleTimeoutSeconds` to the same ceiling.
export const MAX_IDLE_TIMEOUT_SECONDS = 6 * 60 * 60;
