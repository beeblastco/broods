"use client";

/**
 * URL-based environment selection hook.
 * Reads and writes the active environment ID via the ?env= search param so the
 * selection is shareable, bookmarkable, and survives page refreshes.
 */
import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Returns the current environment ID from the URL and a setter that updates the URL.
 * Setting null removes the env param, causing EnvironmentSelector to auto-select the default.
 */
export function useEnvironment() {
    const searchParams = useSearchParams();
    const pathname = usePathname();
    const router = useRouter();

    const environmentId = searchParams.get("env") as Id<"environments"> | null;

    const setEnvironmentId = useCallback(
        (id: Id<"environments"> | null) => {
            const next = new URLSearchParams(searchParams.toString());
            if (id) {
                next.set("env", id);
            } else {
                next.delete("env");
            }
            router.replace(`${pathname}?${next.toString()}`);
        },
        [searchParams, pathname, router],
    );

    return { environmentId, setEnvironmentId };
}
