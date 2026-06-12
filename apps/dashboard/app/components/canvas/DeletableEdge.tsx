"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { useEdgeFanOffset } from "@/app/components/canvas/useEdgeFanOffset";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { useState } from "react";

const HOVER_COLOR = "rgb(239, 68, 68, 0.9)";
const ARROW_ID_PREFIX = "deletable-arrow";

/**
 * Custom edge with a hover-to-delete trash icon. Reads its endpoints to style by kind (A):
 * an agent→sandbox edge is labelled "default".
 */
export function DeletableEdge({
  id,
  source,
  target,
  sourceHandleId,
  targetHandleId,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
}: EdgeProps) {
  const [hovered, setHovered] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === "dark";

  // Endpoint types as a single primitive so the selector stays referentially stable.
  const endpointTypes = useStore(
    (s) =>
      `${s.nodeLookup.get(source)?.type ?? ""}>${s.nodeLookup.get(target)?.type ?? ""}`,
  );
  const [sourceType, targetType] = endpointTypes.split(">");
  const isDefaultSandbox =
    (sourceType === "agent" && targetType === "sandbox") ||
    (sourceType === "sandbox" && targetType === "agent");

  // Fan parallel edges apart so their vertical trunks don't stack (flow is vertical → offset X).
  const [sourceFan, targetFan] = useEdgeFanOffset(
    id,
    source,
    sourceHandleId,
    target,
    targetHandleId,
    "default",
  );

  // Rigid orthogonal routing to match the workspace↔sandbox mount edge styling.
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: sourceX + sourceFan,
    sourceY: sourceY,
    targetX: targetX + targetFan,
    targetY: targetY,
    sourcePosition: sourcePosition,
    targetPosition: targetPosition,
    borderRadius: 16,
  });

  const edgeStyle = hovered
    ? { ...style, stroke: HOVER_COLOR, strokeWidth: 2 }
    : style;
  const arrowColor = hovered
    ? HOVER_COLOR
    : isDark
      ? "rgba(255,255,255,0.35)"
      : "rgba(0,0,0,0.3)";
  const arrowId = `${ARROW_ID_PREFIX}-${id}`;

  return (
    <>
      {/* Inline marker matching the mount/subagent arrowhead geometry, so every edge kind
          shares one arrow style and the color can follow the per-edge hover state. */}
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
          <path d="M -10,-4 L 0,0 L -10,4 Z" fill={arrowColor} />
        </marker>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        style={edgeStyle}
        markerEnd={`url(#${arrowId})`}
      />
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

        <EdgeDeleteButton
          edgeId={id}
          labelX={labelX}
          labelY={labelY}
          onHoverChange={setHovered}
        />
      </EdgeLabelRenderer>
    </>
  );
}
