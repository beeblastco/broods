"use client";

import { EdgeHoverLine } from "@/app/components/canvas/EdgeHoverLine";
import {
  EDGE_LOCK_REASON,
  LockedEdgeBadge,
} from "@/app/components/canvas/LockedEdgeBadge";
import { sideEdgePath, type SideEdgeData } from "@/app/lib/canvasFrameNodes";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

/**
 * Drawn edge from a machine MCP server to the sandbox it runs on. It comes
 * from the server's row, not the saved layout, so it can't be deleted and
 * shows a lock on hover. It carries no text label: the gutter it crosses is
 * narrower than any word, and the server's card or chip already names its
 * computer.
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

  // Fanned and laned by the router, so two servers on one computer never share a leg.
  const [edgePath, labelX, labelY] = data?.route
    ? sideEdgePath(
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

  return (
    <>
      <EdgeHoverLine onHoverChange={setLineHovered}>
        <BaseEdge
          id={id}
          path={edgePath}
          // Only `opacity` from the incoming style, so focus dimming applies but
          // the gray default stroke does not.
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
