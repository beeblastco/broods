"use client";

import { Lock } from "lucide-react";

/**
 * Hover-to-reveal lock indicator for code-managed edges, mirroring EdgeDeleteButton's
 * placement but signalling "you can't change this here" instead of offering a delete.
 * Render inside EdgeLabelRenderer.
 */
export function LockedEdgeBadge({
  labelX,
  labelY,
  onHoverChange,
}: {
  labelX: number;
  labelY: number;
  onHoverChange?: (hovered: boolean) => void;
}) {
  return (
    <div
      className="nodrag nopan group absolute flex cursor-not-allowed items-center justify-center"
      style={{
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
        pointerEvents: "all",
        width: 64,
        height: 64,
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      title="Managed by filthypanty/ code — connection is defined in code"
    >
      <div className="flex cursor-not-allowed items-center justify-center rounded-md border bg-card p-1 text-muted-foreground opacity-0 shadow-sm transition-all group-hover:opacity-100">
        <Lock className="h-3.5 w-3.5" />
      </div>
    </div>
  );
}
