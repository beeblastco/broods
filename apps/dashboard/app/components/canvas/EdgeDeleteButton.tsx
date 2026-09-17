"use client";

import { useReactFlow } from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";

/**
 * Hover-to-reveal delete control centered on an edge midpoint, shared by the custom edges.
 * Reports hover state up so the parent can recolor its stroke. Render inside EdgeLabelRenderer.
 */
export function EdgeDeleteButton({
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
  const { deleteElements } = useReactFlow();
  const onDelete = useCallback(async () => {
    await deleteElements({ edges: [{ id: edgeId }] });
  }, [edgeId, deleteElements]);

  return (
    // 64×64 hit zone centered on the edge midpoint, with no child div intercepting clicks
    <div
      data-edge-control="delete"
      data-edge-id={edgeId}
      className="nodrag nopan group pointer-events-auto absolute top-(--label-y) left-(--label-x) flex size-16 -translate-1/2 items-center justify-center"
      style={{ "--label-x": `${labelX}px`, "--label-y": `${labelY}px` }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <button
        className="flex cursor-pointer items-center justify-center rounded-md border bg-card p-1 text-destructive opacity-0 shadow-sm transition-all group-hover:opacity-100 hover:scale-110 hover:border-destructive/50"
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}
