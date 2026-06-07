"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import {
    BaseEdge,
    EdgeLabelRenderer,
    getBezierPath,
    useStore,
    type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

/**
 * Custom edge with a hover-to-delete trash icon. Reads its endpoints to style by kind (A):
 * an agent→sandbox edge is labelled "default"; an edge into a read-only workspace is dashed.
 */
export function DeletableEdge({
    id,
    source,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
}: EdgeProps) {
    const [hovered, setHovered] = useState(false);

    // Endpoint types as a single primitive so the selector stays referentially stable.
    const endpointTypes = useStore(
        (s) => `${s.nodeLookup.get(source)?.type ?? ""}>${s.nodeLookup.get(target)?.type ?? ""}`,
    );
    const [sourceType, targetType] = endpointTypes.split(">");
    const isDefaultSandbox =
        (sourceType === "agent" && targetType === "sandbox") ||
        (sourceType === "sandbox" && targetType === "agent");
    const workspaceId = sourceType === "workspace" ? source : targetType === "workspace" ? target : null;
    const { workspaceStates } = useInfraAnalysis();
    const isReadonlyWorkspace = workspaceId ? workspaceStates[workspaceId]?.kind === "readonly" : false;

    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX: sourceX,
        sourceY: sourceY,
        targetX: targetX,
        targetY: targetY,
        sourcePosition: sourcePosition,
        targetPosition: targetPosition,
    });

    const edgeStyle = hovered
        ? { ...style, stroke: "rgb(239, 68, 68, 0.9)", strokeWidth: 2 }
        : isReadonlyWorkspace
          ? { ...style, strokeDasharray: "4 3", opacity: 0.55 }
          : style;

    return (
        <>
            <BaseEdge id={id} path={edgePath} style={edgeStyle} markerEnd={markerEnd} />
            <EdgeLabelRenderer>
                {/* Subtle "default" marker at the midpoint; hidden on hover so the delete button takes over */}
                {isDefaultSandbox && !hovered && (
                    <div
                        className="nodrag nopan pointer-events-none absolute text-[8px] font-medium uppercase tracking-[0.08em] text-muted-foreground/50"
                        style={{
                            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
                        }}
                    >
                        default
                    </div>
                )}

                <EdgeDeleteButton edgeId={id} labelX={labelX} labelY={labelY} onHoverChange={setHovered} />
            </EdgeLabelRenderer>
        </>
    );
}
