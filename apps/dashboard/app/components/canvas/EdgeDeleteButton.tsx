"use client";

import { cn } from "@/app/lib/utils";
import { useReactFlow } from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { useCallback } from "react";

export function EdgeDeleteButton({
  edgeId,
  labelX,
  labelY,
  onHoverChange,
  revealed,
}: {
  edgeId: string;
  labelX: number;
  labelY: number;
  onHoverChange?: (hovered: boolean) => void;
  revealed: boolean;
}): React.JSX.Element {
  const { deleteElements } = useReactFlow();
  const onDelete = useCallback(async () => {
    await deleteElements({ edges: [{ id: edgeId }] });
  }, [edgeId, deleteElements]);

  return (
    <div
      data-edge-control="delete"
      data-edge-id={edgeId}
      className="nodrag nopan group pointer-events-auto absolute top-(--label-y) left-(--label-x) flex size-8 -translate-1/2 items-center justify-center"
      style={{ "--label-x": `${labelX}px`, "--label-y": `${labelY}px` }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <button
        aria-label="Delete connection"
        className={cn(
          "flex cursor-pointer items-center justify-center rounded-md border bg-card p-1 text-destructive shadow-sm transition group-hover:opacity-100 hover:scale-110 focus-visible:opacity-100 hover:border-destructive/50",
          revealed ? "opacity-100" : "opacity-0",
        )}
        onClick={onDelete}
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}
