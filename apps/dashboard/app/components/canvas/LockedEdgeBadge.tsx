"use client";

import { Lock } from "lucide-react";

/**
 * Hover-to-reveal lock indicator for code-managed edges, mirroring EdgeDeleteButton's
 * placement but signalling "you can't change this here" instead of offering a delete.
 * Render inside EdgeLabelRenderer.
 */
export function LockedEdgeBadge({
  edgeId,
  labelX,
  labelY,
  onHoverChange,
}: {
  edgeId: string;
  labelX: number;
  labelY: number;
  onHoverChange?: (hovered: boolean) => void;
}): React.JSX.Element {
  return (
    <div
      data-edge-control="locked"
      data-edge-id={edgeId}
      className="nodrag nopan group pointer-events-auto absolute top-(--label-y) left-(--label-x) flex size-16 -translate-1/2 cursor-not-allowed items-center justify-center"
      style={{ "--label-x": `${labelX}px`, "--label-y": `${labelY}px` }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      title="Managed by broods/ code. The connection is defined in code."
    >
      <div className="flex cursor-not-allowed items-center justify-center rounded-md border bg-card p-1 text-muted-foreground opacity-0 shadow-sm transition-all group-hover:opacity-100">
        <Lock className="size-3.5" />
      </div>
    </div>
  );
}
