"use client";

import { CanvasPill } from "@/app/components/canvas/CanvasNotice";
import { clearCreatedProject, isJustCreated } from "@/app/lib/createdProject";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";

const KEY_READY_MS = 8_000;

export function CanvasKeyReady({
  projectId,
  stageId,
}: {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
}): React.JSX.Element | null {
  const [armed, setArmed] = useState(() => isJustCreated(projectId));
  const deployment = useQuery(
    api.agent.deployments.getForStage,
    armed && stageId ? { projectId: projectId, stageId: stageId } : "skip",
  );
  const hasKey = deployment === undefined ? undefined : deployment !== null;
  const visible = armed && hasKey === true;

  // Cleared once the query answers, not on mount: the canvas remounts when its stage loads.
  // oxlint-disable-next-line broods/no-unreasoned-state-sync -- module marker and hide timer
  useEffect(() => {
    if (!armed || hasKey === undefined) return;
    clearCreatedProject();
    if (!hasKey) return;
    const timer = setTimeout(() => setArmed(false), KEY_READY_MS);

    return () => clearTimeout(timer);
  }, [armed, hasKey]);

  if (!visible) return null;

  return (
    <CanvasPill slot="canvas-key-ready">
      Runtime key ready
      <Link
        href={`/${projectId}/dashboard?tab=api-key`}
        className="cursor-pointer text-foreground underline underline-offset-2"
      >
        View
      </Link>
    </CanvasPill>
  );
}
