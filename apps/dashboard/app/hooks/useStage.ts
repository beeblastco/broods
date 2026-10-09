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
  const defaultStageId = defaultStage(stages ?? [])?._id ?? null;
  const stageId =
    stages?.find((stage) => stage._id === stageParam)?._id ?? defaultStageId;
  // The default stage keeps one query key whether or not the URL names it, so
  // picking the stage already on screen does not refetch it.
  const readsDefault =
    stageParam === null || (stageId !== null && stageId === defaultStageId);

  const setStageId = useCallback(
    (id: Id<"stages"> | null) => {
      const next = new URLSearchParams(searchParams.toString());
      // A run or row id belongs to the stage it came from.
      next.delete("trace");
      next.delete("sel");
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
    stageArgs: stageQueryArgs(projectId, readsDefault, stageId),
    setStageId: setStageId,
  };
}

/**
 * The default stage leaves `stageId` out, so the query reads it on the server
 * and a bare URL starts it alongside the stage list. Another stage waits for
 * the list.
 */
function stageQueryArgs(
  projectId: Id<"projects"> | undefined,
  readsDefault: boolean,
  stageId: Id<"stages"> | null,
): StageArgs {
  if (!projectId) return "skip";
  if (readsDefault) return { projectId: projectId };

  return stageId ? { projectId: projectId, stageId: stageId } : "skip";
}
