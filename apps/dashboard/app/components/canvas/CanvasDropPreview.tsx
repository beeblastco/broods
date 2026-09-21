"use client";

/**
 * What a drag says about the group under it: a dashed box around the two cards
 * that would become a group, or the reason the group it is over will not take
 * the card. A frame that will take it opens its own slot, so this draws nothing
 * over one. A child of `<ReactFlow>`, like the connection refusal it shares its
 * notice with.
 */
import {
  CanvasNotice,
  CanvasNoticeHint,
  RefusedOutline,
} from "@/app/components/canvas/CanvasRefusal";
import type { CanvasDrop } from "@/app/lib/canvasDropTarget";
import {
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
} from "@broods/convex/model/canvasFrames";
import { useInternalNode, ViewportPortal } from "@xyflow/react";

export function CanvasDropPreview({
  drop,
}: {
  drop: CanvasDrop | null;
}): React.JSX.Element | null {
  if (drop === null) return null;
  if (drop.refusal !== null) {
    return (
      <>
        <CanvasNotice message={drop.refusal} trailing={<CanvasNoticeHint />} />
        <RefusedOutline
          nodeId={drop.frameId ?? drop.memberIds[0] ?? drop.nodeId}
        />
      </>
    );
  }
  // An existing frame answers for itself: it grows and marks the slot.
  if (drop.frameId !== null || drop.memberIds.length !== 1) return null;

  return (
    <FormingBox
      draggedId={drop.nodeId}
      label={drop.label}
      partnerId={drop.memberIds[0]}
    />
  );
}

/**
 * The group two loose cards would form: the box a frame would draw around both,
 * already carrying the name that frame will take. Drawn in flow coordinates, so
 * it pans and zooms with the cards and follows the one being dragged.
 */
function FormingBox({
  draggedId,
  label,
  partnerId,
}: {
  draggedId: string;
  label: string;
  partnerId: string;
}): React.JSX.Element | null {
  const dragged = useInternalNode(draggedId);
  const partner = useInternalNode(partnerId);
  if (!dragged || !partner) return null;
  const boxes = [dragged, partner].map((node) => ({
    bottom: node.internals.positionAbsolute.y + (node.measured.height ?? 0),
    right: node.internals.positionAbsolute.x + (node.measured.width ?? 0),
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
  }));
  const x = Math.min(...boxes.map((box) => box.x)) - FRAME_PADDING;
  const y = Math.min(...boxes.map((box) => box.y)) - FRAME_HEADER_HEIGHT;

  return (
    <ViewportPortal>
      <div
        data-slot="canvas-drop-preview"
        className="pointer-events-none absolute top-(--preview-y) left-(--preview-x) h-(--preview-height) w-(--preview-width) rounded-md border border-dashed border-canvas-mount"
        style={{
          "--preview-height": `${Math.max(...boxes.map((box) => box.bottom)) + FRAME_PADDING - y}px`,
          "--preview-width": `${Math.max(...boxes.map((box) => box.right)) + FRAME_PADDING - x}px`,
          "--preview-x": `${x}px`,
          "--preview-y": `${y}px`,
        }}
      >
        <div className="flex h-7 items-center px-2.5 text-2xs text-canvas-mount">
          {label}
        </div>
      </div>
    </ViewportPortal>
  );
}
