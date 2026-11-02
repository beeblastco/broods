export const MAX_OUTPUT_BYTES = 1024 * 1024;
// Also the most CPU one command may burn; Convex's WORKER_MAX_TIMEOUT_SECONDS must match.
export const MAX_TIMEOUT_MS = 60 * 1000;
// One compressed R2 object, under the 32 MiB an RPC message may carry.
export const MAX_STATE_BYTES = 16 * 1024 * 1024;
