"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Width of the element under the returned callback ref, kept current as it
 * resizes. Used by the usage charts, which draw at real pixel width, and the
 * trace waterfall, which sizes its timeline column by the table's width.
 */
export function useElementWidth(
  initial: number,
): [number, (el: HTMLElement | null) => void] {
  const [width, setWidth] = useState(initial);
  const observerRef = useRef<ResizeObserver | null>(null);
  const measureRef = useCallback((el: HTMLElement | null): void => {
    observerRef.current?.disconnect();
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.offsetWidth));
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  return [width, measureRef];
}
