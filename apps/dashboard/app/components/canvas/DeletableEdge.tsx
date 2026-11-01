"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { EdgeHoverLine } from "@/app/components/canvas/EdgeHoverLine";
import { LockedEdgeBadge } from "@/app/components/canvas/LockedEdgeBadge";
import { useCodeManagedEdge } from "@/app/components/canvas/useCodeManagedEdge";
import {
  agentEdgePath,
  stepEdgePath,
  type AgentEdgeData,
} from "@/app/lib/canvasFrameNodes";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { useState } from "react";

export const AGENT_EDGE_STROKE: Record<"dark" | "light", string> = {
  dark: "rgba(255,255,255,0.4)",
  light: "rgba(0,0,0,0.35)",
};

const ARROW_ID_PREFIX = "deletable-arrow";

export function DeletableEdge({
  id,
  source,
  target,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  deletable,
}: EdgeProps<Edge<AgentEdgeData>>): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [lineHovered, setLineHovered] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const codeManaged = useCodeManagedEdge(id, source, target);

  // The router skips a target above its agent; that edge falls back to a step path.
  const [edgePath, labelX, labelY] = data?.route
    ? agentEdgePath(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        data.route,
      )
    : stepEdgePath({
        sourceX: sourceX,
        sourceY: sourceY,
        targetX: targetX,
        targetY: targetY,
        sourcePosition: sourcePosition,
        targetPosition: targetPosition,
      });

  const locked = deletable === false || codeManaged;
  const deleteHover = hovered && !locked;
  const arrowColor = isDark ? AGENT_EDGE_STROKE.dark : AGENT_EDGE_STROKE.light;
  const arrowId = `${ARROW_ID_PREFIX}-${id}`;

  return (
    <>
      {/* In user space, so the hover stroke bump does not scale the arrow. */}
      <defs>
        <marker
          id={arrowId}
          viewBox="-10 -5 10 10"
          refX="-1"
          refY="0"
          markerWidth="9"
          markerHeight="9"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path
            d="M -10,-4 L 0,0 L -10,4 Z"
            fill={arrowColor}
            className={deleteHover ? "fill-destructive/90" : undefined}
          />
        </marker>
      </defs>

      <EdgeHoverLine onHoverChange={setLineHovered}>
        <BaseEdge
          id={id}
          path={edgePath}
          style={style}
          // Important, to beat the default stroke inline in `style`.
          className={
            deleteHover ? "stroke-destructive/90! stroke-2!" : undefined
          }
          markerEnd={`url(#${arrowId})`}
        />
      </EdgeHoverLine>
      <EdgeLabelRenderer>
        {locked ? (
          <LockedEdgeBadge
            edgeId={id}
            labelX={labelX}
            labelY={labelY}
            onHoverChange={setHovered}
            revealed={lineHovered}
          />
        ) : (
          <EdgeDeleteButton
            edgeId={id}
            labelX={labelX}
            labelY={labelY}
            onHoverChange={setHovered}
            revealed={lineHovered}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
}
