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

/**
 * The canvas's one refusal notice: why it will not take what is being dragged,
 * and what ends the sentence.
 *
 * The red is the destructive button's, translucent in dark mode, so it sits on
 * an opaque backing or the cards under it show through. The panel spans the
 * canvas and centres the box itself: React Flow's own top-center sits at
 * `left: 50%`, which caps a shrink-to-fit box at half the canvas and wraps a
 * sentence that has room. The strip takes no clicks, only the box does.
 */
export function CanvasNotice({
  message,
  trailing,
}: {
  message: string;
  trailing: React.ReactNode;
}): React.JSX.Element {
  return (
    <Panel
      position="top-left"
      className="pointer-events-none right-0 flex justify-center"
    >
      <div className="pointer-events-auto rounded-lg bg-background shadow-sm">
        <div
          aria-live="polite"
          data-slot="canvas-refusal"
          className="flex max-w-xl items-center gap-2 rounded-lg bg-destructive px-2 py-1 text-xs text-white dark:bg-destructive/60"
        >
          <span className="min-w-0">{message}</span>
          {trailing}
        </div>
      </div>
    </Panel>
  );
}

/** What a notice ends with while the thing it is about is still held. */
export function CanvasNoticeHint(): React.JSX.Element {
  return <span className="shrink-0 opacity-80">Release to cancel</span>;
}

/** A red box over the refused card or group, in flow coordinates so it pans and zooms. */
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
