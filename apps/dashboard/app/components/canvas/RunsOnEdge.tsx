"use client";

import { sideEdgePath, type SideEdgeData } from "@/app/lib/canvasFrameNodes";
import {
  BaseEdge,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

/**
 * Display-only edge from a machine MCP server to the sandbox it runs on. It
 * comes from the server's row, not the saved layout, so it has no delete
 * control. It carries no label: the gutter it crosses is narrower than any
 * word, and the server's card or chip already names its computer.
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
  // Fanned and laned by the router, so two servers on one computer never share a leg.
  const [edgePath] = data?.route
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
    <BaseEdge
      id={id}
      path={edgePath}
      // Only `opacity` from the incoming style, so focus dimming applies but
      // the gray default stroke does not.
      className="stroke-canvas-runs/60! opacity-(--edge-opacity)"
      style={{
        "--edge-opacity": style?.opacity,
        "--xy-edge-stroke-width": 1.5,
      }}
      strokeDasharray="2 3"
    />
  );
}
