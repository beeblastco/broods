/**
 * Lambda cold-start timing. The module graph loads during the INIT phase, so the
 * first handler entry marks the boundary between init (cold start) and request
 * work. The first agent run in this execution environment consumes the window to
 * emit it as a phase span; warm invocations and later runs see nothing.
 */

// Process spawn approximated from uptime at module load (during INIT).
const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

// Upper bound on a real init window. AWS caps the INIT phase well under this; a
// larger gap means the container initialized, then idled in the pool before its
// first request (e.g. provisioned concurrency). That idle is not this request's
// latency, so clamp it — otherwise the cold-start span balloons the whole trace.
const MAX_COLD_START_MS = 60_000;

let coldStartWindow: { startMs: number; endMs: number } | undefined;
let coldStartConsumed = false;

/**
 * Record the first handler entry of this execution environment. Only the first
 * call wins, capturing the init window [process start, first handler entry].
 */
export function markHandlerEntry(now: number): void {
  coldStartWindow ??= { startMs: PROCESS_START_MS, endMs: now };
}

/**
 * Read and clear the cold-start window so the first agent run can emit it as a
 * single phase span. Returns null on warm runs and after the first consumption.
 */
export function consumeColdStart(): { startMs: number; durationMs: number } | null {
  if (coldStartConsumed || !coldStartWindow) {
    return null;
  }
  coldStartConsumed = true;

  const rawDurationMs = Math.max(0, coldStartWindow.endMs - coldStartWindow.startMs);
  const durationMs = Math.min(rawDurationMs, MAX_COLD_START_MS);

  // Anchor the (possibly clamped) window to the handler entry so the span never
  // starts before the request and inflate the trace duration.
  return {
    startMs: coldStartWindow.endMs - durationMs,
    durationMs: durationMs,
  };
}
