"use client";

import {
    BaseEdge,
    EdgeLabelRenderer,
    getBezierPath,
    useReactFlow,
    type EdgeProps,
} from "@xyflow/react";
import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";

/** Custom edge that shows a trash icon on hover to delete the connection. */
export function DeletableEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
}: EdgeProps) {
    const { deleteElements } = useReactFlow();
    const [deleteHovered, setDeleteHovered] = useState(false);

    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX: sourceX,
        sourceY: sourceY,
        targetX: targetX,
        targetY: targetY,
        sourcePosition: sourcePosition,
        targetPosition: targetPosition,
    });

    const onDelete = useCallback(async () => {
        await deleteElements({ edges: [{ id: id }] });
    }, [id, deleteElements]);

    const edgeStyle = deleteHovered
        ? { ...style, stroke: "rgb(239, 68, 68, 0.9)", strokeWidth: 2 }
        : style;

    return (
        <>
            <BaseEdge id={id} path={edgePath} style={edgeStyle} markerEnd={markerEnd} />
            <EdgeLabelRenderer>
                <div
                    className="nodrag nopan group absolute"
                    style={{
                        transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                        pointerEvents: "all",
                    }}
                >
                    {/* Invisible hover zone around the midpoint */}
                    <div className="absolute -inset-8" />
                    <button
                        className="flex items-center justify-center rounded-md border bg-card p-1 text-red-500 shadow-sm opacity-0 transition-all group-hover:opacity-100 hover:scale-110 hover:border-red-500/50"
                        onClick={onDelete}
                        onMouseEnter={() => setDeleteHovered(true)}
                        onMouseLeave={() => setDeleteHovered(false)}
                    >
                        <Trash2 className="h-4 w-4" />
                    </button>
                </div>
            </EdgeLabelRenderer>
        </>
    );
}
