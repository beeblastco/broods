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
  stepEdgePath,
  type DrawnEdgeKind,
  type SideEdgeData,
} from "@/app/lib/canvasFrameNodes";
import type { WorkspaceSandboxState } from "@/app/lib/canvasRuntimeRefs";
import { cn } from "@/app/lib/utils";
import {
  BaseEdge,
  EdgeLabelRenderer,
  useStore,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { useState } from "react";

const ARROW_ID_PREFIX = "mount-arrow";

type MountEdgeControl =
  | { kind: "delete" }
  | { kind: "locked"; reason: string }
  | {
      kind: "mount";
      stateKind: "inherited" | "override";
      workspaceId: string;
    };

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
          // Only `opacity` comes from `style`, which also carries the gray default stroke.
          // xyflow's unlayered edge-path rule outranks utilities, hence `!` and its width var.
          className={cn(
            "opacity-(--edge-opacity)",
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

// Collapsed or code-owned mounts can only say why; a writer's mount word opens the menu.
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

function useWorkspaceEnd(source: string, target: string): string | null {
  // A string, so the selector result stays stable across store updates.
  return useStore((state): string | null => {
    if (state.nodeLookup.get(source)?.type === "workspace") return source;

    return state.nodeLookup.get(target)?.type === "workspace" ? target : null;
  });
}
