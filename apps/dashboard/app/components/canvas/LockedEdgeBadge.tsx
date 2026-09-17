"use client";

import type { DrawnEdgeKind } from "@/app/lib/canvasFrameNodes";
import { cn } from "@/app/lib/utils";
import { Lock } from "lucide-react";

/** Why an edge can't be changed here: code owns it, or the canvas draws it from other state. */
export const EDGE_LOCK_REASON: Record<DrawnEdgeKind | "code", string> = {
  code: "Managed by broods/ code. The connection is defined in code.",
  collapsed: "Expand the group to change this connection.",
  inherited:
    "Inherited from the agent's default sandbox. Mount the workspace on a sandbox to change it.",
  runsOn:
    "The MCP server runs on this computer. Change it in the server's config.",
};

/**
 * Hover-to-reveal lock indicator for an edge that can't be deleted, mirroring
 * EdgeDeleteButton's placement but signalling "you can't change this here", and
 * saying why on hover. `revealed` shows it while the edge's line is hovered.
 * Render inside EdgeLabelRenderer.
 */
export function LockedEdgeBadge({
  edgeId,
  labelX,
  labelY,
  onHoverChange,
  reason = EDGE_LOCK_REASON.code,
  revealed,
}: {
  edgeId: string;
  labelX: number;
  labelY: number;
  onHoverChange?: (hovered: boolean) => void;
  reason?: string;
  revealed: boolean;
}): React.JSX.Element {
  return (
    <div
      data-edge-control="locked"
      data-edge-id={edgeId}
      className="nodrag nopan group pointer-events-auto absolute top-(--label-y) left-(--label-x) flex size-8 -translate-1/2 cursor-not-allowed items-center justify-center"
      style={{ "--label-x": `${labelX}px`, "--label-y": `${labelY}px` }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
      title={reason}
    >
      <div
        className={cn(
          "flex cursor-not-allowed items-center justify-center rounded-md border bg-card p-1 text-muted-foreground shadow-sm transition-opacity group-hover:opacity-100",
          revealed ? "opacity-100" : "opacity-0",
        )}
      >
        <Lock className="size-3.5" />
      </div>
    </div>
  );
}
