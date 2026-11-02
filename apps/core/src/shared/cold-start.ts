const PROCESS_START_MS = Date.now() - Math.round(process.uptime() * 1000);

// A longer init window is idle time before the first request, not this request's latency.
const MAX_COLD_START_MS = 60_000;

let coldStartWindow: { startMs: number; endMs: number } | undefined;
let coldStartConsumed = false;

export function markHandlerEntry(now: number): void {
  coldStartWindow ??= { startMs: PROCESS_START_MS, endMs: now };
}

export function consumeColdStart(
  runStartedMs: number,
): { startMs: number; durationMs: number } | null {
  if (coldStartConsumed || !coldStartWindow) {
    return null;
  }
  coldStartConsumed = true;

  // A run that began long after process start did not pay for init.
  if (runStartedMs - PROCESS_START_MS > MAX_COLD_START_MS) {
    return null;
  }

  const rawDurationMs = Math.max(
    0,
    coldStartWindow.endMs - coldStartWindow.startMs,
  );
  const durationMs = Math.min(rawDurationMs, MAX_COLD_START_MS);

  return {
    startMs: coldStartWindow.endMs - durationMs,
    durationMs: durationMs,
  };
}
