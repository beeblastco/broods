"use client";

import { useEffect, useState } from "react";

// Labels built on this read minutes or hours, so a 30 second tick keeps them
// no more than a minute stale.
const CLOCK_TICK_MS = 30_000;

/**
 * Ticking wall clock for relative-time labels. A component re-renders only when
 * its data changes, so without this an age or a countdown freezes at whatever
 * it read on its last render. `tickMs` sets the pace; null stops the clock.
 */
export function useNow(tickMs: number | null = CLOCK_TICK_MS): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (tickMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), tickMs);

    return () => clearInterval(timer);
  }, [tickMs]);

  return now;
}
