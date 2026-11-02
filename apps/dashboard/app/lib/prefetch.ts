"use client";

import type { useRouter } from "next/navigation";

type RouterPrefetchOptions = Parameters<
  ReturnType<typeof useRouter>["prefetch"]
>[1];

// A dynamic route then reuses the whole prefetched tree instead of loading partially.
export const FULL_ROUTE_PREFETCH = { kind: "full" } as RouterPrefetchOptions;
