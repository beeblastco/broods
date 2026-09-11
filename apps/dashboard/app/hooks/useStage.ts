"use client";

/**
 * Reads and writes the active stage ID via the ?stage= search param so the
 * selection is shareable, bookmarkable, and survives page refreshes.
 */
import type { Id } from "@broods/convex/_generated/dataModel";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/** Setting null removes the stage param, so StageSelector auto-selects the default. */
export function useStage(): {
  stageId: Id<"stages"> | null;
  setStageId: (id: Id<"stages"> | null) => void;
} {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const stageId = searchParams.get("stage") as Id<"stages"> | null;

  const setStageId = useCallback(
    (id: Id<"stages"> | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (id) {
        next.set("stage", id);
      } else {
        next.delete("stage");
      }
      const query = next.toString();
      // The native History API is wired into the App Router, so this updates
      // `useSearchParams` without the server round trip `router.replace`
      // makes for a new URL. The default stage lands on every bare project
      // URL, so that trip used to sit on the cold-load path.
      window.history.replaceState(
        null,
        "",
        query ? `${pathname}?${query}` : pathname,
      );
    },
    [searchParams, pathname],
  );

  return { stageId: stageId, setStageId: setStageId };
}
