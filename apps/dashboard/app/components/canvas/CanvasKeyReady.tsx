"use client";

import { CanvasPill } from "@/app/components/canvas/CanvasNotice";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";

// How long the pill stays up before it clears itself.
const KEY_READY_MS = 8_000;

// The project the create dialog just made, read once by its canvas. Module
// state, so it lives through the client-side navigation and not a reload.
// It expires so a canvas opened much later never shows a stale notice.
const CREATED_MARKER_MS = 60_000;
let createdProject: { at: number; projectId: string } | null = null;

/**
 * Says the new project's runtime key exists, once, on the canvas the create
 * dialog opens. `markProjectCreated` arms it for one project; it stays quiet
 * when the stage has no key (an org not provisioned yet).
 */
export function CanvasKeyReady({
  projectId,
  stageId,
}: {
  projectId: Id<"projects">;
  stageId: Id<"stages"> | null;
}): React.JSX.Element | null {
  const [armed, setArmed] = useState(
    () =>
      createdProject?.projectId === projectId &&
      Date.now() - createdProject.at < CREATED_MARKER_MS,
  );
  const deployment = useQuery(
    api.agent.deployments.getForStage,
    armed && stageId ? { projectId: projectId, stageId: stageId } : "skip",
  );
  const visible = armed && Boolean(deployment);

  // No key on this stage (org not provisioned): drop the marker for good.
  useEffect(() => {
    if (armed && deployment === null) createdProject = null;
  }, [armed, deployment]);

  // Consumed only once the pill is on screen: the canvas remounts when its
  // stage loads, and a slow key lookup must not eat the display time.
  useEffect(() => {
    if (!visible) return;
    createdProject = null;
    const timer = setTimeout(() => setArmed(false), KEY_READY_MS);

    return () => clearTimeout(timer);
  }, [visible]);

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

/** Called by the create dialog right before it opens the new project. */
export function markProjectCreated(projectId: string): void {
  createdProject = { at: Date.now(), projectId: projectId };
}
