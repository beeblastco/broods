"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/app/components/ui/dropdown-menu";
import type { WorkspaceMountTarget } from "@/app/lib/canvasFrameEdits";
import { WORKSPACE_STATE_LABEL } from "@/app/lib/memberStatus";
import { cn } from "@/app/lib/utils";
import { Box, CornerDownRight, Eye } from "lucide-react";
import { useState } from "react";

/**
 * What a mount row that names no sandbox says, and the line under it. Shared
 * with the card's right-click menu, which lists the same places and drops the
 * detail line.
 */
export const FIXED_MOUNT_ROWS = {
  default: {
    detail: "Follows the agent's first sandbox",
    icon: CornerDownRight,
    label: "Agent default",
  },
  readonly: {
    detail: "Reads from S3, mounts nowhere",
    icon: Eye,
    label: "No sandbox, read-only",
  },
};

/**
 * The word a workspace's mount edge carries, and the menu behind it: every
 * place that workspace can mount. It replaces the trash on a stored mount and
 * the lock on the inherited one, which between them could only delete the
 * mount or refuse. The word shows without a hover, so a glance over the board
 * says which mounts are drawn and which follow an agent. Render inside
 * EdgeLabelRenderer.
 *
 * `opacity` is the edge's own, so focus mode fades the word with the line it
 * labels instead of leaving it lit over a dimmed board.
 */
export function MountStateLabel({
  edgeId,
  kind,
  labelX,
  labelY,
  onHoverChange,
  opacity,
  workspaceId,
}: {
  edgeId: string;
  kind: "inherited" | "override";
  labelX: number;
  labelY: number;
  onHoverChange?: (hovered: boolean) => void;
  opacity: number | string | undefined;
  workspaceId: string;
}): React.JSX.Element {
  const { mountTargetsOf, onSetWorkspaceMount } = useCanvasFrames();
  // Read when the menu opens: the rows then match the graph as it stands,
  // without the canvas handing every card a new context on each edit.
  const [targets, setTargets] = useState<readonly WorkspaceMountTarget[]>([]);

  return (
    // React Flow draws its edges div after the label layer and neither sets a
    // z-index, so every edge's invisible 20px hit stroke lies over this word.
    // The label layer is not a stacking context, so one z-index here is enough
    // to take the click; 32px tall to match the trash and the lock.
    <div
      data-edge-control="mount"
      data-edge-id={edgeId}
      className={cn(
        "nodrag nopan absolute top-(--label-y) left-(--label-x) z-1 flex h-8 -translate-1/2 items-center opacity-(--edge-opacity)",
        // A faded word is background, not a target: the menu would open over
        // the card the focus is on.
        opacity === undefined ? "pointer-events-auto" : "pointer-events-none",
      )}
      style={{
        "--edge-opacity": opacity,
        "--label-x": `${labelX}px`,
        "--label-y": `${labelY}px`,
      }}
      onMouseEnter={() => onHoverChange?.(true)}
      onMouseLeave={() => onHoverChange?.(false)}
    >
      <DropdownMenu
        onOpenChange={(open: boolean): void => {
          if (open) setTargets(mountTargetsOf(workspaceId));
        }}
      >
        {/* The edge's dashed line runs under this word, so the hover tint needs
            something opaque behind it or the dashes read straight through. */}
        <span className="bg-background rounded-sm">
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Change where this workspace mounts"
                className="text-canvas-mount border-canvas-mount/40 hover:border-canvas-mount hover:bg-canvas-mount/10 block cursor-pointer rounded-sm border px-1.5 py-0.5 text-3xs shadow-sm"
              />
            }
          >
            {WORKSPACE_STATE_LABEL[kind]}
          </DropdownMenuTrigger>
        </span>

        <DropdownMenuContent align="center" className="w-60">
          <DropdownMenuGroup>
            <DropdownMenuLabel variant="muted">Mounts on</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {/* A stage with many sandboxes would otherwise run this list off
                the screen; the rows scroll under the heading instead. */}
            <div className="max-h-48 overflow-y-auto">
              {targets.map((target) => {
                const row =
                  target.kind === "sandbox"
                    ? { detail: null, icon: Box, label: target.label }
                    : FIXED_MOUNT_ROWS[target.kind];
                const Icon = row.icon;

                return (
                  <DropdownMenuItem
                    key={
                      target.kind === "sandbox" ? target.sandboxId : target.kind
                    }
                    data-active={target.current}
                    className="cursor-pointer"
                    onClick={() => onSetWorkspaceMount(workspaceId, target)}
                  >
                    <Icon />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{row.label}</span>
                      {row.detail && (
                        <span className="text-muted-foreground text-2xs">
                          {row.detail}
                        </span>
                      )}
                    </span>
                  </DropdownMenuItem>
                );
              })}
            </div>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
