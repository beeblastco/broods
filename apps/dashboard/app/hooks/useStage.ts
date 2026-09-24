"use client";

/**
 * The active stage: the ?stage= search param when it names one of the
 * project's stages, else the project's default stage. The default is derived,
 * never written to the URL on load, so a bare project URL stays bare and no
 * history write can discard a navigation the user started meanwhile.
 */
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/** Setting null removes the stage param, so the default stage applies. */
export function useStage(): {
  stageId: Id<"stages"> | null;
  setStageId: (id: Id<"stages"> | null) => void;
} {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const params = useParams<{ projectId?: string }>();
  const projectId = params.projectId as Id<"projects"> | undefined;
  const stages = useQuery(
    api.stage.list,
    projectId ? { projectId: projectId } : "skip",
  ) as Doc<"stages">[] | undefined;

  const stageParam = searchParams.get("stage") as Id<"stages"> | null;
  const stageId =
    stages?.length && !stages.some((stage) => stage._id === stageParam)
      ? defaultStage(stages)._id
      : stageParam;

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
      // makes for a new URL. Only an explicit stage pick lands here.
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

/** The Development default, else any Development stage, else the default, else the first. */
function defaultStage(stages: Doc<"stages">[]): Doc<"stages"> {
  return (
    stages.find((stage) => stage.kind === "development" && stage.isDefault) ??
    stages.find((stage) => stage.kind === "development") ??
    stages.find((stage) => stage.isDefault) ??
    stages[0]
  );
}
