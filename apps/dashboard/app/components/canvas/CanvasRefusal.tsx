"use client";

import {
  CanvasNotice,
  CanvasNoticeHint,
} from "@/app/components/canvas/CanvasNotice";
import { useConnectionRefusal } from "@/app/components/canvas/useConnectionRefusal";
import type { ConnectionGraph } from "@/app/lib/canvasConnections";
import {
  useInternalNode,
  ViewportPortal,
  type OnConnectEnd,
} from "@xyflow/react";
import { useImperativeHandle, type Ref } from "react";

export type CanvasRefusalHandle = {
  clear: () => void;
  onConnectEnd: OnConnectEnd;
};

// Inside <ReactFlow>: held by the canvas, each card the line crosses would re-render it.
export function CanvasRefusal({
  getGraph,
  ref,
}: {
  getGraph: () => ConnectionGraph;
  ref: Ref<CanvasRefusalHandle>;
}): React.JSX.Element | null {
  const { clear, onConnectEnd, refusal } = useConnectionRefusal(getGraph);
  useImperativeHandle(
    ref,
    (): CanvasRefusalHandle => ({ clear: clear, onConnectEnd: onConnectEnd }),
    [clear, onConnectEnd],
  );
  if (refusal === null) return null;

  return (
    <>
      <CanvasNotice
        message={refusal.message}
        trailing={
          refusal.dropped ? (
            <button
              type="button"
              className="shrink-0 cursor-pointer underline underline-offset-2"
              onClick={clear}
            >
              Dismiss
            </button>
          ) : (
            <CanvasNoticeHint />
          )
        }
      />
      <RefusedOutline nodeId={refusal.nodeId} />
    </>
  );
}

export function RefusedOutline({
  nodeId,
}: {
  nodeId: string;
}): React.JSX.Element | null {
  const node = useInternalNode(nodeId);
  if (!node) return null;

  return (
    <ViewportPortal>
      <div
        data-slot="canvas-refused-outline"
        className="pointer-events-none absolute top-(--refused-y) left-(--refused-x) h-(--refused-height) w-(--refused-width) rounded-md border border-destructive"
        style={{
          "--refused-height": `${node.measured.height ?? 0}px`,
          "--refused-width": `${node.measured.width ?? 0}px`,
          "--refused-x": `${node.internals.positionAbsolute.x}px`,
          "--refused-y": `${node.internals.positionAbsolute.y}px`,
        }}
      />
    </ViewportPortal>
  );
}
