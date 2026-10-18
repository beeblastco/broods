/**
 * Per-call ceilings the Worker enforces. Core's executor imports this file to
 * clamp its requests, so the two cannot drift.
 */

// Per stream, after the runtime cut it on a character boundary.
export const MAX_OUTPUT_BYTES = 1024 * 1024;
// An isolate's CPU limit is set once per sandbox config, so this is also the
// most CPU one command may burn; a shell that only shuffles text rarely needs
// seconds. `WORKER_MAX_TIMEOUT_SECONDS` in the Convex rules is the same number.
export const MAX_TIMEOUT_MS = 60 * 1000;
// A reserved sandbox's files, compressed, as one R2 object. Under the 32 MiB
// an RPC message may carry, with the uncompressed disk capped below that too.
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
