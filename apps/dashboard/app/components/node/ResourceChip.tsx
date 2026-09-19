"use client";

import {
  NetworkBadge,
  useSideHandlesConnectable,
} from "@/app/components/node/BaseNode";
import { cn } from "@/app/lib/utils";
import { Handle, Position } from "@xyflow/react";

/** Dot color class, text, and the full text for the tooltip when the line says less. */
export type ChipStatus = { color: string; text: string; title?: string };

/**
 * A sandbox, workspace or MCP node drawn inside a frame: a chip with its icon,
 * name and one status line, at a card's width. Clicking it opens it into a
 * card, which is the same element grown to a card's slot, so the chips under
 * it slide down rather than being covered. Side handles are always mounted so
 * mount and runs-on edges can attach; only sandbox and workspace chips
 * (`mountable`) accept a new mount drawn onto them.
 */
export function ResourceChip({
  details,
  expanded,
  icon,
  label,
  mountable,
  networkOn,
  nodeType,
  status,
}: {
  /** The line under the name while it is open, the same one its card shows. */
  details?: string;
  expanded: boolean;
  icon: React.ReactNode;
  label: string;
  mountable: boolean;
  /** Sandboxes only: draws the egress globe while it is open. */
  networkOn?: boolean;
  nodeType: string;
  status: ChipStatus;
}): React.JSX.Element {
  const sideHandlesConnectable = useSideHandlesConnectable(nodeType);

  return (
    <div
      data-slot="resource-chip"
      data-expanded={expanded}
      // w-44 by h-11 is FRAME_CHIP_WIDTH by FRAME_CHIP_HEIGHT, the slot the frame
      // leaves; open it fills FRAME_MEMBER_CARD_HEIGHT with a card's padding.
      className={cn(
        "relative flex w-44 cursor-pointer flex-col rounded-md border border-border bg-card transition-all duration-200 ease-out hover:border-foreground/25",
        expanded ? "h-24 px-3 py-2.5" : "h-11 justify-center gap-0.5 px-1.5",
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
        <span className="shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0 truncate" title={label}>
          {label}
        </span>
      </div>
      {expanded && details !== undefined && (
        <div className="mt-1 truncate text-2xs text-muted-foreground">
          {details}
        </div>
      )}
      <div
        className={cn(
          "flex min-w-0 items-center gap-1 text-muted-foreground",
          expanded ? "mt-auto gap-1.5 text-2xs" : "text-3xs",
        )}
      >
        <span
          data-slot="chip-status"
          className={cn("size-1.5 shrink-0 rounded-full", status.color)}
        />
        <span className="truncate" title={status.title ?? status.text}>
          {status.text}
        </span>
        {expanded && networkOn !== undefined && <NetworkBadge on={networkOn} />}
      </div>
    </div>
  );
}
