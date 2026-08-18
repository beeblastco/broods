"use client";

/**
 * URL-based stage selection hook.
 * Reads and writes the active stage ID via the ?stage= search param so the
 * selection is shareable, bookmarkable, and survives page refreshes.
 */
import type { Id } from "@broods/convex/_generated/dataModel";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useTransition } from "react";

/**
 * Returns the current stage ID from the URL and a setter that updates the URL.
 * Setting null removes the stage param, causing StageSelector to auto-select the default.
 */
export function useStage(): {
  stageId: Id<"stages"> | null;
  setStageId: (id: Id<"stages"> | null) => void;
} {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const [, startTransition] = useTransition();

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
      // Wrap in startTransition so the URL change is non-urgent and avoids
      // blocking user interactions while the canvas tree re-renders.
      startTransition(() => {
        router.replace(query ? `${pathname}?${query}` : pathname);
      });
    },
    [searchParams, pathname, router, startTransition],
  );

  return { stageId: stageId, setStageId: setStageId };
}
