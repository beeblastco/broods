"use client";

import { resampleRows } from "@/app/lib/usageChart";
import { useEffect, useRef, useState } from "react";

const TWEEN_MS = 600;

/**
 * Eases displayed rows from what is on screen to `target` over one short
 * ease-in-out pass, resampling first when the row count changes. Used by the
 * usage charts and tiles so a range switch or live update morphs instead of
 * jumping. `target` must be memoized; a new identity starts a new pass.
 */
export function useTween(target: number[][]): number[][] {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  useEffect(() => {
    const from = resampleRows(shownRef.current, target.length);
    const reduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let start: number | null = null;
    let frame = 0;
    const step = (now: number): void => {
      start ??= now;
      const t = reduced ? 1 : Math.min(1, (now - start) / TWEEN_MS);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      const next = target.map((row, i) =>
        row.map((value, k) => {
          const a = from[i]?.[k] ?? 0;

          return a + (value - a) * e;
        }),
      );
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);

    return () => cancelAnimationFrame(frame);
  }, [target]);

  return shown;
}
