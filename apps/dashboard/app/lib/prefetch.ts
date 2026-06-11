"use client";

import type { useRouter } from "next/navigation";

type RouterPrefetchOptions = Parameters<ReturnType<typeof useRouter>["prefetch"]>[1];

/**
 * Force full App Router prefetch for dynamic routes so navigation can reuse
 * the complete prefetched tree instead of doing partial route loading.
 */
export const FULL_ROUTE_PREFETCH = { kind: "full" } as RouterPrefetchOptions;
