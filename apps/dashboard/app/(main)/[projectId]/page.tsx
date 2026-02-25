"use client";

/** Architecture page — renders the canvas for the current project. */
import { use } from "react";
import { Canvas } from "@/app/components/canvas/Canvas";
import type { Id } from "@/convex/_generated/dataModel";

export default function ArchitecturePage({
    params,
}: {
    params: Promise<{ projectId: string }>;
}) {
    const { projectId } = use(params);

    return <Canvas projectId={projectId as Id<"projects">} />;
}
