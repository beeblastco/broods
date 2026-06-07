"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import {
    BaseEdge,
    EdgeLabelRenderer,
    getSmoothStepPath,
    type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

const MOUNT_COLOR = "rgba(20, 184, 166, 0.55)";
const MOUNT_COLOR_HOVER = "rgb(239, 68, 68, 0.9)";
const ARROW_ID_PREFIX = "mount-arrow";

/**
 * Edge for workspace↔sandbox mount relationships.
 * Renders via side handles with bidirectional arrows to show data flows in both directions.
 */
export function MountEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
}: EdgeProps) {
    const [hovered, setHovered] = useState(false);

    const [edgePath, labelX, labelY] = getSmoothStepPath({
        sourceX: sourceX,
        sourceY: sourceY,
        targetX: targetX,
        targetY: targetY,
        sourcePosition: sourcePosition,
        targetPosition: targetPosition,
        borderRadius: 16,
    });

    const stroke = hovered ? MOUNT_COLOR_HOVER : MOUNT_COLOR;
    const arrowId = `${ARROW_ID_PREFIX}-${id}`;

    return (
        <>
            {/* Inline marker defs so each mount edge owns its arrowheads */}
            <defs>
                <marker
                    id={arrowId}
                    viewBox="-10 -5 10 10"
                    refX="-1"
                    refY="0"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                >
                    <path d="M -10,-4 L 0,0 L -10,4 Z" fill={stroke} />
                </marker>
            </defs>

            <BaseEdge
                id={id}
                path={edgePath}
                style={{
                    stroke: stroke,
                    strokeWidth: 1.5,
                    strokeDasharray: "5 3",
                    animation: "dashdraw 0.5s linear infinite",
                }}
                markerStart={`url(#${arrowId})`}
                markerEnd={`url(#${arrowId})`}
            />

            <EdgeLabelRenderer>
                <EdgeDeleteButton edgeId={id} labelX={labelX} labelY={labelY} onHoverChange={setHovered} />
            </EdgeLabelRenderer>
        </>
    );
}
