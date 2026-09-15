"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { useEdgeFanOffset } from "@/app/components/canvas/useEdgeFanOffset";
import { cn } from "@/app/lib/utils";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

const ARROW_ID_PREFIX = "subagent-arrow";

/**
 * Edge for agent→agent subagent relationships. Renders via side handles in a distinct
 * violet, with a single arrowhead pointing at the callee (source can call target).
 */
export function SubagentEdge({
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
}: EdgeProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);

  // Fan parallel subagent edges apart so their trunks don't stack (horizontal flow → offset Y).
  const [sourceFan, targetFan] = useEdgeFanOffset(
    id,
    source,
    sourceHandleId,
    target,
    targetHandleId,
    "subagent",
  );

  // Bezier (not orthogonal) so dense agent↔agent webs spread as smooth curves between fanned
  // endpoints, with no shared-center jog to collide the way blocky routing does.
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: sourceX,
    sourceY: sourceY + sourceFan,
    targetX: targetX,
    targetY: targetY + targetFan,
    sourcePosition: sourcePosition,
    targetPosition: targetPosition,
  });

  const arrowId = `${ARROW_ID_PREFIX}-${id}`;

  return (
    <>
      {/* Inline marker def so each subagent edge owns its arrowhead in its own color */}
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
              hovered ? "fill-destructive/90" : "fill-canvas-subagent/65"
            }
          />
        </marker>
      </defs>

      <BaseEdge
        id={id}
        path={edgePath}
        // Keep the violet stroke but honor focus-mode dimming: pull only `opacity` from the
        // incoming style (which also carries the gray default stroke we must not apply).
        // xyflow's unlayered edge-path rule outranks utilities, so the stroke is important
        // and the width goes through xyflow's own variable.
        className={cn(
          "opacity-(--edge-opacity)",
          hovered ? "stroke-destructive/90!" : "stroke-canvas-subagent/65!",
        )}
        style={{
          "--edge-opacity": style?.opacity,
          "--xy-edge-stroke-width": 1.5,
        }}
        markerEnd={`url(#${arrowId})`}
      />

      <EdgeLabelRenderer>
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
