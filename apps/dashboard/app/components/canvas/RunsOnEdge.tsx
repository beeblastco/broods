"use client";

import { EdgeHoverLine } from "@/app/components/canvas/EdgeHoverLine";
import {
  EDGE_LOCK_REASON,
  LockedEdgeBadge,
} from "@/app/components/canvas/LockedEdgeBadge";
import {
  sideEdgePath,
  stepEdgePath,
  type SideEdgeData,
} from "@/app/lib/canvasFrameNodes";
import {
  BaseEdge,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

/**
 * A machine MCP server's edge to its sandbox. It comes from the server row, so it is locked;
 * no text label, since the gutter it crosses is narrower than any word.
 */
export function RunsOnEdge({
  id,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
}: EdgeProps<Edge<SideEdgeData>>): React.JSX.Element {
  const [lineHovered, setLineHovered] = useState(false);

  const [edgePath, labelX, labelY] = data?.route
    ? sideEdgePath(
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

  return (
    <>
      <EdgeHoverLine onHoverChange={setLineHovered}>
        <BaseEdge
          id={id}
          path={edgePath}
          // Only `opacity` from `style`: focus dimming applies, its gray default stroke does not.
          className="stroke-canvas-runs/80! opacity-(--edge-opacity)"
          style={{
            "--edge-opacity": style?.opacity,
            "--xy-edge-stroke-width": 1.5,
          }}
          strokeDasharray="2 3"
        />
      </EdgeHoverLine>
      <EdgeLabelRenderer>
        <LockedEdgeBadge
          edgeId={id}
          labelX={labelX}
          labelY={labelY}
          reason={EDGE_LOCK_REASON.runsOn}
          revealed={lineHovered}
        />
      </EdgeLabelRenderer>
    </>
  );
}
