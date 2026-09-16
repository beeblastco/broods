"use client";

import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { LockedEdgeBadge } from "@/app/components/canvas/LockedEdgeBadge";
import {
  isCodeManagedEdgeId,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import { useEdgeFanOffset } from "@/app/components/canvas/useEdgeFanOffset";
import { BUNDLE_EDGE_PREFIX, bundleEdgePath } from "@/app/lib/canvasFrameNodes";
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

  // Fan edges that land on one handle apart (flow is vertical → offset X). The source end is
  // not fanned: an agent's edges leave its bottom as one trunk and split along the way, where
  // fanned starts drew a row of stubs that curled into each other.
  const [, targetFan] = useEdgeFanOffset(
    id,
    source,
    sourceHandleId,
    target,
    targetHandleId,
    "default",
  );

  // Rigid orthogonal routing to match the workspace↔sandbox mount edge styling. A bundle edge
  // into a frame takes the column gutter instead, and several agents' bundles into one frame
  // share its handle rather than fan.
  const [edgePath, labelX, labelY] = id.startsWith(BUNDLE_EDGE_PREFIX)
    ? bundleEdgePath({ x: sourceX, y: sourceY }, { x: targetX, y: targetY })
    : getSmoothStepPath({
        sourceX: sourceX,
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
