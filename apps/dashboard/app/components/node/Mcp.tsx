"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { ResourceChip } from "@/app/components/node/ResourceChip";
import type { StageMcpServer } from "@/app/lib/canvasFrameNodes";
import { mcpMemberStatus } from "@/app/lib/memberStatus";
import type { NodeProps } from "@xyflow/react";
import { Plug } from "lucide-react";

const TRANSPORT_SUBTITLE: Record<StageMcpServer["transport"], string> = {
  hosted: "hosted · node",
  http: "external · url",
  machine: "your computer · stdio",
};

/**
 * MCP server node: one registered server exposing its tools to wired agents.
 * Reads its row from the stage's server list the Canvas queries once. Inside
 * a frame it draws as a chip naming the computer a machine server runs on.
 * A disabled server reads as idle, the same grey its collapsed frame shows.
 * The card keeps side handles, unconnectable, for its runs-on edge.
 */
export function McpNode({ id, data, parentId }: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const server = useCanvasFrames().mcpServers.get(id);
  const status = mcpMemberStatus(server);

  if (parentId !== undefined) {
    return (
      <ResourceChip
        icon={<Plug className="size-3.5" />}
        label={nodeData.label}
        mountable={false}
        nodeType="mcp"
        status={{
          color: status.color,
          text: server?.sandbox
            ? `${status.label} · ${server.sandbox}`
            : status.label,
        }}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="mcp"
      data={nodeData}
      icon={<Plug className="size-3.5" />}
      subtitle={server ? TRANSPORT_SUBTITLE[server.transport] : undefined}
      liveStatus={{ color: status.color, text: status.label }}
      showSideHandles={server?.transport === "machine"}
    />
  );
}
