/**
 * Per-call ceilings the isolate Worker enforces. Core's isolate executor
 * imports this file to clamp its requests, so the two cannot drift.
 */

export const MAX_OUTPUT_BYTES = 1024 * 1024;
// An isolate's CPU limit is set once per sandbox, so this is also the most CPU
// one command may burn; a shell that only shuffles text rarely needs seconds.
export const MAX_TIMEOUT_MS = 60 * 1000;
// A reserved sandbox's files, compressed, as one R2 object and one RPC message.
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
