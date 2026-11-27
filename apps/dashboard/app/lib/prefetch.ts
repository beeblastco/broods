"use client";

import type { useRouter } from "next/navigation";

type RouterPrefetchOptions = Parameters<
  ReturnType<typeof useRouter>["prefetch"]
>[1];

// A dynamic route then reuses the whole prefetched tree instead of loading partially.
export const FULL_ROUTE_PREFETCH = { kind: "full" } as RouterPrefetchOptions;

/** Runs `warm` once the load event has passed, so a warmed chunk is not part of a cold load. */
export function afterLoad(warm: () => void): () => void {
  let cancel = (): void => {};
  const schedule = (): void => {
    cancel = inBackground(warm);
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });

  return () => {
    window.removeEventListener("load", schedule);
    cancel();
  };
}

/** Runs `task` behind every task the user waits on and returns its cancel. */
export function inBackground(task: () => void): () => void {
  // Safari has neither scheduler nor requestIdleCallback.
  if (typeof scheduler !== "undefined") {
    const controller = new AbortController();
    void scheduler
      .postTask(task, { priority: "background", signal: controller.signal })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });

    return () => controller.abort();
  }
  if (typeof requestIdleCallback !== "undefined") {
    const idleId = requestIdleCallback(task);

    return () => cancelIdleCallback(idleId);
  }
  const timer = setTimeout(task);

  return () => clearTimeout(timer);
}
