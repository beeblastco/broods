import { MOTION_MS, prefersReducedMotion } from "@/app/lib/motion";
import { useEffect, useState } from "react";

export function usePresence<T>(
  value: T | null,
  exitMs: number = MOTION_MS.base,
): { value: T | null; closing: boolean } {
  const [retained, setRetained] = useState(value);
  if (value !== null && value !== retained) setRetained(value);
  const closing = value === null && retained !== null;

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- exit transition timer
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
