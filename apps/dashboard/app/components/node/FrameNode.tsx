"use client";

/**
 * A frame around two or more sandbox, workspace or MCP chips an agent reaches.
 * Expanded, it is only the dashed box and header; the member chips render
 * themselves inside it. Collapsed, it is one compact card that names its
 * members and sums up their state.
 */
import {
  useCanvasFrames,
  type CanvasFramesValue,
} from "@/app/components/canvas/CanvasFramesContext";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import { useNow } from "@/app/hooks/useNow";
import type { FrameNodeType } from "@/app/lib/canvasFrameNodes";
import type { CanvasInfraAnalysis } from "@/app/lib/canvasRuntimeRefs";
import { machineStateByName } from "@/app/lib/machineConnection";
import {
  mcpMemberStatus,
  sandboxMemberStatus,
  summarizeMembers,
  workspaceMemberStatus,
  type MemberStatus,
} from "@/app/lib/memberStatus";
import { cn } from "@/app/lib/utils";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight } from "lucide-react";

const HANDLE_CLASS = "bg-transparent! w-2.5! h-2.5! border-transparent!";

export function FrameNode({
  id,
  data,
}: NodeProps<FrameNodeType>): React.JSX.Element {
  const { collapsed, frame, members } = data;
  const frames = useCanvasFrames();
  const infraAnalysis = useInfraAnalysis();
  const now = useNow();
  const summary = summarizeMembers(
    members.map((member) => memberStatus(member, frames, infraAnalysis, now)),
  );
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div
      data-slot="canvas-frame"
      data-collapsed={collapsed}
      className={cn(
        "relative flex size-full flex-col rounded-md border border-border",
        collapsed
          ? "bg-card hover:border-foreground/25"
          : "border-dashed bg-transparent",
      )}
    >
      {/* Bundle edges from the agent land on top; mount and runs-on edges
          re-point to the sides while the frame is collapsed. */}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
      <Handle
        id="left"
        type="source"
        position={Position.Left}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={HANDLE_CLASS}
      />
      <div className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 px-2.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">{frame.label}</span>
        <span className="ml-auto tabular-nums">{members.length}</span>
        <button
          type="button"
          aria-label={
            collapsed ? `Expand ${frame.label}` : `Collapse ${frame.label}`
          }
          aria-expanded={!collapsed}
          className="nodrag cursor-pointer hover:text-foreground"
          onClick={(event) => {
            // Toggling is not a focus click on the frame.
            event.stopPropagation();
            frames.onToggleFrame(id);
          }}
        >
          <Chevron className="size-3.5" />
        </button>
      </div>
      {collapsed && (
        <>
          <div className="truncate px-2.5 text-2xs text-muted-foreground">
            {members
              .map((member) => (member.data as BaseNodeData).label)
              .join(", ")}
          </div>
          <div className="mt-auto flex items-center gap-1.5 px-2.5 pb-2 text-2xs text-muted-foreground">
            <span
              data-slot="frame-status"
              className={cn("size-1.5 shrink-0 rounded-full", summary.color)}
            />
            <span className="truncate">{summary.text}</span>
          </div>
        </>
      )}
    </div>
  );
}

/** The status a member's chip shows, from the same stage data the chip reads. */
function memberStatus(
  member: Node,
  frames: CanvasFramesValue,
  infraAnalysis: CanvasInfraAnalysis,
  now: number,
): MemberStatus {
  const data = member.data as BaseNodeData;
  if (member.type === "mcp") {
    return mcpMemberStatus(frames.mcpServers.get(member.id));
  }
  if (member.type === "workspace") {
    return workspaceMemberStatus(infraAnalysis.workspaceStates[member.id]);
  }
  const machine =
    data.config?.provider === "machine"
      ? machineStateByName(frames.machineConnections, data.label, now)
      : undefined;

  return sandboxMemberStatus(data, machine);
}
