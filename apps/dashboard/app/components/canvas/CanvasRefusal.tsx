"use client";

import { useConnectionRefusal } from "@/app/components/canvas/useConnectionRefusal";
import type { ConnectionGraph } from "@/app/lib/canvasConnections";
import {
  Panel,
  useInternalNode,
  ViewportPortal,
  type OnConnectEnd,
} from "@xyflow/react";
import { useImperativeHandle, type Ref } from "react";

/** What the canvas calls into: its connect-end prop, and a clear for the next click or drag. */
export type CanvasRefusalHandle = {
  clear: () => void;
  onConnectEnd: OnConnectEnd;
};

/**
 * Why the canvas refuses the connection being drawn: a notice at the top and a
 * red outline on the card it is about. A child of `<ReactFlow>` on purpose. It
 * follows the line through the flow store, and held in the canvas component
 * that would re-render the whole canvas each time the line crosses a card.
 */
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

  // The red is the destructive button's, translucent in dark mode, so it sits
  // on an opaque backing or the cards under it show through. `w-max` because
  // the panel is centred with `left: 50%`, which caps a shrink-to-fit box at
  // half the canvas and wraps a sentence that has room.
  return (
    <>
      <Panel position="top-center">
        <div className="rounded-lg bg-background shadow-sm">
          <div
            aria-live="polite"
            data-slot="canvas-refusal"
            className="flex w-max max-w-xl items-center gap-2 rounded-lg bg-destructive px-2 py-1 text-xs text-white dark:bg-destructive/60"
          >
            <span className="min-w-0">{refusal.message}</span>
            {refusal.dropped ? (
              <button
                type="button"
                className="shrink-0 cursor-pointer underline underline-offset-2"
                onClick={clear}
              >
                Dismiss
              </button>
            ) : (
              <span className="shrink-0 opacity-80">Release to cancel</span>
            )}
          </div>
        </div>
      </Panel>
      <RefusedOutline nodeId={refusal.nodeId} />
    </>
  );
}

/** A red box over the refused card, drawn in flow coordinates so it pans and zooms with it. */
function RefusedOutline({
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
