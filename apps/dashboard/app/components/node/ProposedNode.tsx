"use client";

import { NODE_TEMPLATES } from "@/app/components/canvas/nodeTemplates";
import type { ProposedNodeType } from "@/app/lib/proposedNodes";
import { cn } from "@/app/lib/utils";
import { NODE_HEIGHT } from "@broods/convex/model/canvasLayout";
import { Handle, Position, type NodeProps } from "@xyflow/react";

const HANDLE_CLASS = "bg-transparent! w-2.5! h-2.5! border-transparent!";

/** A node a dock proposal adds: dashed until its deploy lands, red when it failed. */
export function ProposedNode({
  data,
}: NodeProps<ProposedNodeType>): React.JSX.Element {
  const { failed, kind, label } = data;
  const template = NODE_TEMPLATES.find((item) => item.type === kind);
  const Icon = template?.icon;

  return (
    <div
      data-proposed-node={failed ? "failed" : "add"}
      className={cn(
        "relative flex h-(--card-height) w-44 flex-col rounded-md border border-dashed bg-card",
        failed ? "border-destructive" : "border-canvas-mount",
      )}
      style={{ "--card-height": `${NODE_HEIGHT}px` }}
    >
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
      <div className="px-3 pt-2.5">
        <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="min-w-0 truncate text-foreground">{label}</span>
        </div>
        <div className="mt-1 truncate text-2xs text-muted-foreground">
          {template?.label}
        </div>
      </div>
    </div>
  );
}
