"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { LockedEdgeBadge } from "@/app/components/canvas/LockedEdgeBadge";
import { useCodeManagedEdge } from "@/app/components/canvas/useCodeManagedEdge";
import { agentEdgePath, type AgentEdgeData } from "@/app/lib/canvasFrameNodes";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useTheme } from "next-themes";
import { useState } from "react";

const ARROW_ID_PREFIX = "deletable-arrow";

/**
 * Custom edge with a hover-to-delete trash icon, or a lock badge when code owns it. A bundle
 * edge from an agent to a frame is locked when any edge it stands for is.
 */
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
  const { theme } = useTheme();
  const isDark = theme === "dark";

  const codeManaged = useCodeManagedEdge(id, source, target);

  // Agent to resource, bottom to top along the lanes the canvas routed for it. An edge the
  // router skipped (a target above its agent) falls back to a step path.
  const [edgePath, labelX, labelY] = data?.route
    ? agentEdgePath(
        { x: sourceX, y: sourceY },
        { x: targetX, y: targetY },
        data.route,
      )
    : getSmoothStepPath({
        sourceX: sourceX,
        sourceY: sourceY,
        targetX: targetX,
        targetY: targetY,
        sourcePosition: sourcePosition,
        targetPosition: targetPosition,
        borderRadius: 16,
      });

  // Code-managed edges can't be deleted here: no red delete-hover, no trash. Canvas marks
  // them, and bundles of them, `deletable: false`.
  const locked = deletable === false || codeManaged;
  const deleteHover = hovered && !locked;
  const arrowColor = isDark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.3)";
  const arrowId = `${ARROW_ID_PREFIX}-${id}`;

  return (
    <>
      {/* Inline marker matching the mount/subagent arrowhead geometry, so every edge kind
          shares one arrow style and the color can follow the per-edge hover state. Sized in
          user space (6 × the 1.5 base stroke) so the hover strokeWidth bump to 2 doesn't
          scale the arrow up. Markers default to strokeWidth units. */}
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

      <BaseEdge
        id={id}
        path={edgePath}
        style={style}
        // Important, so the hover stroke wins over the default stroke inline in `style`.
        className={deleteHover ? "stroke-destructive/90! stroke-2!" : undefined}
        markerEnd={`url(#${arrowId})`}
      />
      <EdgeLabelRenderer>
        {locked ? (
          <LockedEdgeBadge
            edgeId={id}
            labelX={labelX}
            labelY={labelY}
            onHoverChange={setHovered}
          />
        ) : (
          <EdgeDeleteButton
            edgeId={id}
            labelX={labelX}
            labelY={labelY}
            onHoverChange={setHovered}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
}
