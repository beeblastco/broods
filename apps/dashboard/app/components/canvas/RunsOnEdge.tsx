"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";

/**
 * Display-only edge from a machine MCP server to the sandbox it runs on. It
 * comes from the server's row, not the saved layout, so it has no delete
 * control.
 */
export function RunsOnEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
}: EdgeProps): React.JSX.Element {
  const [edgePath, labelX, labelY] = getSmoothStepPath({
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
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-none absolute top-(--label-y) left-(--label-x) -translate-1/2 text-3xs font-medium uppercase tracking-widest text-muted-foreground opacity-(--edge-opacity)"
          style={{
            "--edge-opacity": style?.opacity,
            "--label-x": `${labelX}px`,
            "--label-y": `${labelY}px`,
          }}
        >
          runs on
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
