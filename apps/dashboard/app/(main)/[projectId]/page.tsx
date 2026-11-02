"use client";

// Eager on purpose: the header prefetches routes whole, and a lazy chunk cost first paint.
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
