"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { LockedEdgeBadge } from "@/app/components/canvas/LockedEdgeBadge";
import {
  isCodeManagedEdgeId,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import { useEdgeFanOffset } from "@/app/components/canvas/useEdgeFanOffset";
import { cn } from "@/app/lib/utils";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useStore,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

const ARROW_ID_PREFIX = "mount-arrow";

/**
 * Edge for workspace↔sandbox mount relationships.
 * Renders via side handles with bidirectional arrows to show data flows in both directions.
 */
export function MountEdge({
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
  deletable,
}: EdgeProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const endpointOwnership = useStore((s) => {
    const sourceData = s.nodeLookup.get(source)?.data as
      | { managedBy?: string }
      | undefined;
    const targetData = s.nodeLookup.get(target)?.data as
      | { managedBy?: string }
      | undefined;

    return `${sourceData?.managedBy ?? ""}>${targetData?.managedBy ?? ""}`;
  });
  const [sourceManagedBy, targetManagedBy] = endpointOwnership.split(">");

  // Fan parallel mounts apart so their trunks don't stack (flow is horizontal → offset Y).
  const [sourceFan, targetFan] = useEdgeFanOffset(
    id,
    source,
    sourceHandleId,
    target,
    targetHandleId,
    "mount",
  );

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: sourceX,
    sourceY: sourceY + sourceFan,
    targetX: targetX,
    targetY: targetY + targetFan,
    sourcePosition: sourcePosition,
    targetPosition: targetPosition,
    borderRadius: 16,
  });

  // Code-managed edges can't be deleted here, so they never show the red
  // delete-hover or the trash button, only a lock badge. A mount re-pointed to
  // a collapsed frame is drawn, not stored, so it shows neither.
  const locked =
    isCodeManagedEdgeId(id) ||
    (isCodeManagedOwner(sourceManagedBy) &&
      isCodeManagedOwner(targetManagedBy));
  const removable = !locked && deletable !== false;
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
