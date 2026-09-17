"use client";

import { useSideHandlesConnectable } from "@/app/components/node/BaseNode";
import { cn } from "@/app/lib/utils";
import { Handle, Position } from "@xyflow/react";

/** Dot color class and text for a chip's status line. */
/** Dot color class, text, and the full text for the tooltip when the line says less. */
export type ChipStatus = { color: string; text: string; title?: string };

/**
 * A sandbox, workspace or MCP node drawn inside a frame: a chip with its icon,
 * name, one status line and an optional note line. Side handles are always
 * mounted so mount and runs-on edges can attach; only sandbox and workspace
 * chips (`mountable`) accept a new mount drawn onto them.
 */
export function ResourceChip({
  icon,
  label,
  mountable,
  nodeType,
  note,
  orderNumber,
  status,
}: {
  icon: React.ReactNode;
  label: string;
  mountable: boolean;
  nodeType: string;
  /** A third line under the status, e.g. how many agents share a workspace. */
  note?: string;
  /** A sandbox's place in its agent's `sandboxes`. */
  orderNumber?: number;
  status: ChipStatus;
}): React.JSX.Element {
  const sideHandlesConnectable = useSideHandlesConnectable(nodeType);

  return (
    <div
      data-slot="resource-chip"
      // w-46 by h-11 or h-15 is FRAME_CHIP_WIDTH by FRAME_CHIP_HEIGHTS, the slot the frame leaves.
      className={cn(
        "relative flex w-46 cursor-pointer flex-col justify-center rounded-md border border-border bg-card px-1.5 hover:border-foreground/25",
        nodeType === "workspace" ? "h-15 gap-1" : "h-11 gap-0.5",
      )}
    >
      {/* Like a card's: an agent dragged onto a chip wires it too. */}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectableStart={false}
        className="bg-transparent! w-2.5! h-2.5! border-transparent!"
      />
      {(["left", "right"] as const).map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={side === "left" ? Position.Left : Position.Right}
          isConnectable={mountable}
          isConnectableEnd={sideHandlesConnectable}
          className="bg-transparent! w-2.5! h-2.5! border-transparent!"
        />
      ))}
      <div className="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
        {orderNumber !== undefined && (
          <span className="w-2.5 shrink-0 text-2xs tabular-nums text-muted-foreground">
            {orderNumber}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1 text-3xs text-muted-foreground">
        <span
          data-slot="chip-status"
          className={cn("size-1.5 shrink-0 rounded-full", status.color)}
        />
        <span className="truncate" title={status.title ?? status.text}>
          {status.text}
        </span>
      </div>
      {note && (
        <div className="truncate pl-2.5 text-3xs text-muted-foreground">
          {note}
        </div>
      )}
    </div>
  );
}
