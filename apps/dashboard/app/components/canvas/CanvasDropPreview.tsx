"use client";

/**
 * What a drag says about the group under it: the frame two loose cards would
 * become, or the reason the group it is over will not take the card. A frame that
 * will take it opens its own slot, so this draws nothing over one. A child of
 * `<ReactFlow>`, like the connection refusal it shares its notice with.
 */
import {
  CanvasNotice,
  CanvasNoticeHint,
  RefusedOutline,
} from "@/app/components/canvas/CanvasRefusal";
import type { CanvasDrop } from "@/app/lib/canvasDropTarget";
import { DROP_SLOT_ID, withDropSlot } from "@/app/lib/canvasFrameNodes";
import {
  FRAME_HEADER_HEIGHT,
  FRAME_PADDING,
  frameMemberPositions,
  frameSize,
  type FrameKind,
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
  // An existing frame answers for itself: it grows and marks the slot. Anything
  // else here would be a group of one, which is the only shape that forms.
  if (drop.frameId !== null || drop.memberIds.length !== 1) return null;

  return (
    <FormingFrame
      kind={drop.kind}
      label={drop.label}
      memberId={drop.memberIds[0]}
      slot={drop.slot}
    />
  );
}

/**
 * The frame two loose cards would form: its box, at the size and place it will
 * really take, with the slot the dragged card would fill.
 *
 * A new frame takes the origin of the card already in the group, which is what
 * `reconcileFramePositions` gives it, so the preview is the outcome rather than a
 * box drawn around wherever the two cards happen to be.
 */
function FormingFrame({
  kind,
  label,
  memberId,
  slot,
}: {
  kind: FrameKind;
  label: string;
  memberId: string;
  slot: number;
}): React.JSX.Element | null {
  const member = useInternalNode(memberId);
  if (!member) return null;
  const shape = { kind: kind, memberIds: withDropSlot([memberId], slot) };
  const size = frameSize(shape);
  const origin = {
    x: member.internals.positionAbsolute.x - FRAME_PADDING,
    y: member.internals.positionAbsolute.y - FRAME_HEADER_HEIGHT,
  };
  const slotAt = frameMemberPositions(origin, shape).get(DROP_SLOT_ID);

  return (
    <ViewportPortal>
      <div
        data-slot="canvas-drop-preview"
        className="pointer-events-none absolute top-(--preview-y) left-(--preview-x) h-(--preview-height) w-(--preview-width) rounded-md border border-dashed border-canvas-mount"
        style={{
          "--preview-height": `${size.height}px`,
          "--preview-width": `${size.width}px`,
          "--preview-x": `${origin.x}px`,
          "--preview-y": `${origin.y}px`,
        }}
      >
        {/* h-7 is FRAME_HEADER_HEIGHT, as the frame's own header is. */}
        <div className="flex h-7 items-center px-2.5 text-2xs text-canvas-mount">
          {label}
        </div>
      </div>
      {slotAt && (
        <div
          data-slot="canvas-drop-preview-slot"
          // h-11 by w-44 is FRAME_CHIP_HEIGHT by FRAME_CHIP_WIDTH, a chip's slot.
          className="pointer-events-none absolute top-(--slot-y) left-(--slot-x) h-11 w-44 rounded-md border border-dashed border-canvas-mount bg-canvas-mount/10"
          style={{
            "--slot-x": `${slotAt.x}px`,
            "--slot-y": `${slotAt.y}px`,
          }}
        />
      )}
    </ViewportPortal>
  );
}
