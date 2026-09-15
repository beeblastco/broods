"use client";

import { useEffect, useState } from "react";

// Labels built on this read minutes or hours, so a 30 second tick keeps them
// no more than a minute stale.
const CLOCK_TICK_MS = 30_000;

/**
 * Ticking wall clock for relative-time labels. A component re-renders only when
 * its data changes, so without this an age or a countdown freezes at whatever
 * it read on its last render.
 */
export function useNow(): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);

    return () => clearInterval(timer);
  }, []);

  return now;
}
