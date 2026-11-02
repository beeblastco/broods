export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const MAX_TIMEOUT_MS = 15 * 60 * 1000;
// setInactivityTimeout's own ceiling; the config plane caps idleTimeoutSeconds to match.
export const MAX_IDLE_TIMEOUT_SECONDS = 6 * 60 * 60;
