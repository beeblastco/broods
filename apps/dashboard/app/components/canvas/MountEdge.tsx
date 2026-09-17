"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { LockedEdgeBadge } from "@/app/components/canvas/LockedEdgeBadge";
import { useCodeManagedEdge } from "@/app/components/canvas/useCodeManagedEdge";
import { sideEdgePath, type SideEdgeData } from "@/app/lib/canvasFrameNodes";
import { cn } from "@/app/lib/utils";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

const ARROW_ID_PREFIX = "mount-arrow";

/**
 * Edge for workspace↔sandbox mount relationships, and the drawn edge from a workspace to the
 * sandbox it inherits. Renders via side handles with bidirectional arrows to show data flows
 * in both directions, along the lanes the canvas routed for it.
 */
export function MountEdge({
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
}: EdgeProps<Edge<SideEdgeData>>): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const codeManaged = useCodeManagedEdge(id, source, target);

  // An edge the router skipped (no measured handle yet) falls back to a step path.
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

  // A drawn edge (a mount re-pointed to a collapsed frame, an inherited sandbox) is not
  // stored, so it offers neither a lock nor a trash. A stored code-managed mount shows the
  // lock and never the red delete-hover.
  const displayOnly = data?.displayOnly === true;
  const locked = codeManaged && !displayOnly;
  const removable = !codeManaged && !displayOnly && deletable !== false;
  const deleteHover = hovered && removable;
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
          <path
            d="M -10,-4 L 0,0 L -10,4 Z"
            className={
              deleteHover ? "fill-destructive/90" : "fill-canvas-mount/55"
            }
          />
        </marker>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        // Keep the teal stroke but honor focus-mode dimming: pull only `opacity` from the
        // incoming style (which also carries the gray default stroke we must not apply).
        // xyflow's unlayered edge-path rule outranks utilities, so the stroke is important
        // and the width goes through xyflow's own variable.
        className={cn(
          "animate-dashdraw opacity-(--edge-opacity)",
          deleteHover ? "stroke-destructive/90!" : "stroke-canvas-mount/55!",
        )}
        style={{
          "--edge-opacity": style?.opacity,
          "--xy-edge-stroke-width": 1.5,
        }}
        strokeDasharray="5 3"
        markerStart={`url(#${arrowId})`}
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
          removable && (
            <EdgeDeleteButton
              edgeId={id}
              labelX={labelX}
              labelY={labelY}
              onHoverChange={setHovered}
            />
          )
        )}
      </EdgeLabelRenderer>
    </>
  );
}
