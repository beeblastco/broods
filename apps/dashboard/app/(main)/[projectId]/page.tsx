"use client";

/** Architecture page — renders the canvas for the current project. */
import type { Id } from "@broods/convex/_generated/dataModel";
import dynamic from "next/dynamic";
import { use } from "react";

// Defer the entire ReactFlow bundle until the user navigates to a project.
const Canvas = dynamic(
  () => import("@/app/components/canvas/Canvas").then((mod) => mod.Canvas),
  {
    loading: () => (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading canvas...</p>
      </div>
    ),
  },
);

export default function ArchitecturePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = use(params);

  return <Canvas projectId={projectId as Id<"projects">} />;
}
