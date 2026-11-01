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
 * A mount edge's label and its menu of mount targets. Render inside EdgeLabelRenderer;
 * `opacity` is the edge's own, so focus mode fades the word with its line.
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
  // Read on open, so the canvas need not hand every card a new context on each edit.
  const [targets, setTargets] = useState<readonly WorkspaceMountTarget[]>([]);

  return (
    // React Flow's edges div paints over the label layer, so every edge's 20px hit stroke
    // covers this word; the label layer is no stacking context, so one z-index wins the click.
    <div
      data-edge-control="mount"
      data-edge-id={edgeId}
      className={cn(
        "nodrag nopan absolute top-(--label-y) left-(--label-x) z-1 flex h-8 -translate-1/2 items-center opacity-(--edge-opacity)",
        // Faded by focus mode: a click would open the menu over the focused card.
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
        {/* Opaque, or the edge's dashes show through the hover tint. */}
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
