import { MOTION_MS, prefersReducedMotion } from "@/app/lib/motion";
import { useEffect, useState } from "react";

/**
 * Keeps the last non-null `value` for `exitMs` after it turns null, so a
 * closing panel still renders what it showed while its exit transition
 * plays. A new value while closing takes over at once; under reduced motion
 * it lets go at once.
 */
export function usePresence<T>(
  value: T | null,
  exitMs: number = MOTION_MS.base,
): { value: T | null; closing: boolean } {
  const [retained, setRetained] = useState(value);
  if (value !== null && value !== retained) setRetained(value);
  const closing = value === null && retained !== null;

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(
      () => setRetained(null),
      prefersReducedMotion() ? 0 : exitMs,
    );

    return () => window.clearTimeout(timer);
  }, [closing, exitMs]);

  return { value: value ?? retained, closing: closing };
}
