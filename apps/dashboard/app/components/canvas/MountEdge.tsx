"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { EdgeDeleteButton } from "@/app/components/canvas/EdgeDeleteButton";
import { EdgeHoverLine } from "@/app/components/canvas/EdgeHoverLine";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import {
  EDGE_LOCK_REASON,
  LockedEdgeBadge,
} from "@/app/components/canvas/LockedEdgeBadge";
import { MountStateLabel } from "@/app/components/canvas/MountStateLabel";
import { useCodeManagedEdge } from "@/app/components/canvas/useCodeManagedEdge";
import {
  sideEdgePath,
  type DrawnEdgeKind,
  type SideEdgeData,
} from "@/app/lib/canvasFrameNodes";
import type { WorkspaceSandboxState } from "@/app/lib/canvasRuntimeRefs";
import { cn } from "@/app/lib/utils";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useStore,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

const ARROW_ID_PREFIX = "mount-arrow";

/** The one control an edge's midpoint shows, and what it needs to render. */
type MountEdgeControl =
  | { kind: "delete" }
  | { kind: "locked"; reason: string }
  | {
      kind: "mount";
      stateKind: "inherited" | "override";
      workspaceId: string;
    };

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
  const [lineHovered, setLineHovered] = useState(false);
  const codeManaged = useCodeManagedEdge(id, source, target);
  const canWrite = useCanvasFrames().canWrite;
  const workspaceId = useWorkspaceEnd(source, target);
  const workspaceState = useInfraAnalysis().workspaceStates[workspaceId ?? ""];

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

  const control = mountEdgeControl({
    canWrite: canWrite,
    codeManaged: codeManaged,
    deletable: deletable,
    drawn: data?.drawn,
    stateKind: workspaceState?.kind,
    workspaceId: workspaceId,
  });
  const deleteHover = hovered && control.kind === "delete";
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
              deleteHover ? "fill-destructive/90" : "fill-canvas-mount/80"
            }
          />
        </marker>
      </defs>

      <EdgeHoverLine onHoverChange={setLineHovered}>
        <BaseEdge
          id={id}
          path={edgePath}
          // Keep the teal stroke but honor focus-mode dimming: pull only `opacity` from the
          // incoming style (which also carries the gray default stroke we must not apply).
          // xyflow's unlayered edge-path rule outranks utilities, so the stroke is important
          // and the width goes through xyflow's own variable.
          className={cn(
            "animate-dashdraw opacity-(--edge-opacity)",
            deleteHover ? "stroke-destructive/90!" : "stroke-canvas-mount/80!",
          )}
          style={{
            "--edge-opacity": style?.opacity,
            "--xy-edge-stroke-width": 1.5,
          }}
          strokeDasharray="5 3"
          markerStart={`url(#${arrowId})`}
          markerEnd={`url(#${arrowId})`}
        />
      </EdgeHoverLine>

      <EdgeLabelRenderer>
        {control.kind === "locked" ? (
          <LockedEdgeBadge
            edgeId={id}
            labelX={labelX}
            labelY={labelY}
            onHoverChange={setHovered}
            reason={control.reason}
            revealed={lineHovered}
          />
        ) : control.kind === "mount" ? (
          <MountStateLabel
            edgeId={id}
            kind={control.stateKind}
            labelX={labelX}
            labelY={labelY}
            onHoverChange={setHovered}
            opacity={style?.opacity}
            workspaceId={control.workspaceId}
          />
        ) : (
          <EdgeDeleteButton
            edgeId={id}
            labelX={labelX}
            labelY={labelY}
            onHoverChange={setHovered}
            revealed={lineHovered}
          />
        )}
      </EdgeLabelRenderer>
    </>
  );
}

/**
 * What this edge's midpoint offers. A collapsed group hides the cards a
 * re-pointed mount belongs to, and a mount code owns is re-synced from the
 * project it was deployed from: both can only say why. Any other
 * workspace↔sandbox edge carries its mount state as a word that opens the
 * menu, drawn or stored alike, so the board reads the same either way. A
 * reader has no menu, so it keeps the lock or trash it had.
 */
function mountEdgeControl({
  canWrite,
  codeManaged,
  deletable,
  drawn,
  stateKind,
  workspaceId,
}: {
  canWrite: boolean;
  codeManaged: boolean;
  deletable: boolean | undefined;
  drawn: DrawnEdgeKind | undefined;
  stateKind: WorkspaceSandboxState["kind"] | undefined;
  workspaceId: string | null;
}): MountEdgeControl {
  if (drawn === "collapsed") {
    return { kind: "locked", reason: EDGE_LOCK_REASON.collapsed };
  }
  if (codeManaged) {
    return { kind: "locked", reason: EDGE_LOCK_REASON.code };
  }
  if (
    canWrite &&
    workspaceId !== null &&
    (stateKind === "inherited" || stateKind === "override")
  ) {
    return { kind: "mount", stateKind: stateKind, workspaceId: workspaceId };
  }
  if (drawn !== undefined) {
    return { kind: "locked", reason: EDGE_LOCK_REASON[drawn] };
  }
  if (deletable === false) {
    return { kind: "locked", reason: EDGE_LOCK_REASON.code };
  }

  return { kind: "delete" };
}

/** The workspace end of a mount edge, or null when neither end is one. */
function useWorkspaceEnd(source: string, target: string): string | null {
  // A string, so the selector stays referentially stable across store updates.
  return useStore((state): string | null => {
    if (state.nodeLookup.get(source)?.type === "workspace") return source;

    return state.nodeLookup.get(target)?.type === "workspace" ? target : null;
  });
}
