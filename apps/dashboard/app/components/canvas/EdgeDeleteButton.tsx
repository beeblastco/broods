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
}) {
  const { deleteElements } = useReactFlow();
  const onDelete = useCallback(async () => {
    await deleteElements({ edges: [{ id: edgeId }] });
  }, [edgeId, deleteElements]);

  return (
    // 64×64 hit zone centered on the edge midpoint — no child div intercepting clicks
    <div
      className="nodrag nopan group absolute flex items-center justify-center"
      style={{
        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
        pointerEvents: "all",
        width: 64,
        height: 64,
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <button
        className="flex cursor-pointer items-center justify-center rounded-md border bg-card p-1 text-red-500 opacity-0 shadow-sm transition-all group-hover:opacity-100 hover:scale-110 hover:border-red-500/50"
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
