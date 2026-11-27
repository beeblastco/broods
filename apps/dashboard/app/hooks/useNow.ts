"use client";

import { useEffect, useState } from "react";

// Labels read minutes or hours: a 30 s tick keeps them under a minute stale.
const CLOCK_TICK_MS = 30_000;

export function useNow(tickMs: number | null = CLOCK_TICK_MS): number {
  const [now, setNow] = useState<number>(() => Date.now());
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- a wall-clock interval timer
  useEffect(() => {
    if (tickMs === null) return;
    const timer = setInterval(() => setNow(Date.now()), tickMs);

    return () => clearInterval(timer);
  }, [tickMs]);

  return now;
}
