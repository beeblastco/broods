"use client";

import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { defaultStage } from "@broods/convex/model/defaultStage";
import { useQuery } from "convex/react";
import { useParams, usePathname, useSearchParams } from "next/navigation";
import { useCallback } from "react";

type StageArgs = { projectId: Id<"projects">; stageId?: Id<"stages"> } | "skip";

const STAGE_SCOPED_PARAMS = ["trace", "sel"];

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
  // The default stays out of the URL (a load-time write can discard a navigation) and out of the
  // query args: the server resolves it, so one query key and no wait for the stage list.
  const readsDefault =
    stageParam === null || (stageId !== null && stageId === defaultStageId);

  const setStageId = useCallback(
    (id: Id<"stages"> | null) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const param of STAGE_SCOPED_PARAMS) next.delete(param);
      if (id) {
        next.set("stage", id);
      } else {
        next.delete("stage");
      }
      const query = next.toString();
      // The App Router syncs useSearchParams with replaceState, minus router.replace's round trip.
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

function stageQueryArgs(
  projectId: Id<"projects"> | undefined,
  readsDefault: boolean,
  stageId: Id<"stages"> | null,
): StageArgs {
  if (!projectId) return "skip";
  if (readsDefault) return { projectId: projectId };

  return stageId ? { projectId: projectId, stageId: stageId } : "skip";
}
