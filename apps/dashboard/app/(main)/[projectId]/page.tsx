"use client";

/**
 * The canvas is imported with the page, not behind a second request. It used
 * to be a lazy chunk so other routes never carried ReactFlow; the header
 * prefetches every route whole now, so that saved nothing, and the extra
 * request wave cost this page its first paint on a slow link.
 */
import { Canvas } from "@/app/components/canvas/Canvas";
import type { Id } from "@broods/convex/_generated/dataModel";
import { use } from "react";

export default function ArchitecturePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}): React.JSX.Element {
  const { projectId } = use(params);

  return <Canvas projectId={projectId as Id<"projects">} />;
}
