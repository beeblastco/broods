"use client";

/**
 * The active stage: the ?stage= search param when it names one of the
 * project's stages, else the project's default stage, and null until the
 * project's stages load. The default is derived,
 * never written to the URL on load, so a bare project URL stays bare and no
 * history write can discard a navigation the user started meanwhile.
 */
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { defaultStage } from "@broods/convex/model/defaultStage";
import { useQuery } from "convex/react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/** Arguments for a stage-scoped query that resolves a missing `stageId` to the project's default. */
type StageArgs = { projectId: Id<"projects">; stageId?: Id<"stages"> } | "skip";

/** Setting null removes the stage param, so the default stage applies. */
export function useStage(): {
  stageId: Id<"stages"> | null;
  stageArgs: StageArgs;
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

  const stageParam = searchParams.get("stage");
  const stageId =
    (
      stages?.find((stage) => stage._id === stageParam) ??
      defaultStage(stages ?? [])
    )?._id ?? null;

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

  return {
    stageId: stageId,
    stageArgs: stageQueryArgs(projectId, stageParam, stageId),
    setStageId: setStageId,
  };
}

/**
 * A bare project URL leaves `stageId` out, so the query reads the default
 * stage and starts alongside the stage list. A named stage waits for the list.
 */
function stageQueryArgs(
  projectId: Id<"projects"> | undefined,
  stageParam: string | null,
  stageId: Id<"stages"> | null,
): StageArgs {
  if (!projectId) return "skip";
  if (stageParam === null) return { projectId: projectId };

  return stageId ? { projectId: projectId, stageId: stageId } : "skip";
}
