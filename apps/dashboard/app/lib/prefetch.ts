"use client";

import type { useRouter } from "next/navigation";

type RouterPrefetchOptions = Parameters<
  ReturnType<typeof useRouter>["prefetch"]
>[1];

// A dynamic route then reuses the whole prefetched tree instead of loading partially.
export const FULL_ROUTE_PREFETCH = { kind: "full" } as RouterPrefetchOptions;

/** Runs `warm` once the load event has passed, so a warmed chunk is not part of a cold load. */
export function afterLoad(warm: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    timer = setTimeout(warm);
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });

  return () => {
    window.removeEventListener("load", schedule);
    clearTimeout(timer);
  };
}
