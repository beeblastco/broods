"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { LockedEdgeBadge } from "@/app/components/canvas/LockedEdgeBadge";
import {
  isCodeManagedEdgeId,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
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

const ARROW_ID_PREFIX = "deletable-arrow";

/**
 * Custom edge with a hover-to-delete trash icon, or a lock badge when code owns it. A bundle
 * edge from an agent to a frame is locked when any edge it stands for is.
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
  deletable,
}: EdgeProps): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const { theme } = useTheme();
  const isDark = theme === "dark";

  // Endpoint ownership as a single primitive so the selector stays referentially stable.
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

  // Code-managed edges can't be deleted here: no red delete-hover, no trash. Canvas marks
  // them, and bundles of them, `deletable: false`.
  const locked =
    deletable === false ||
    isCodeManagedEdgeId(id) ||
    (isCodeManagedOwner(sourceManagedBy) &&
      isCodeManagedOwner(targetManagedBy));
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
