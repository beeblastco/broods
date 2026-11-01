"use client";

import { prefersReducedMotion } from "@/app/lib/motion";
import { resampleRows } from "@/app/lib/usageChart";
import { useEffect, useRef, useState } from "react";

const TWEEN_MS = 600;

// `target` must be memoized: a new identity starts a new pass.
export function useTween(target: number[][]): number[][] {
  const [shown, setShown] = useState(target);
  const shownRef = useRef(target);

  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- requestAnimationFrame loop
  useEffect(() => {
    const from = resampleRows(shownRef.current, target.length);
    const reduced = prefersReducedMotion();
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
