/**
 * Per-call ceilings the bridge enforces. Core's cloudflare executor imports this
 * file to clamp its requests, so the two cannot drift.
 */

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_TIMEOUT_MS = 15 * 60 * 1000;
