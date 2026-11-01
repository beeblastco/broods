"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { ResourceChip } from "@/app/components/node/ResourceChip";
import type { StageMcpServer } from "@/app/lib/canvasFrameNodes";
import { enabledMemberStatus } from "@/app/lib/memberStatus";
import type { NodeProps } from "@xyflow/react";
import { Plug } from "lucide-react";

const TRANSPORT_SUBTITLE: Record<StageMcpServer["transport"], string> = {
  hosted: "hosted · bundle",
  http: "external · url",
  machine: "your computer · stdio",
};

/** A machine server's card keeps unconnectable side handles for its runs-on edge. */
export function McpNode({ id, data, parentId }: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const { expandedMemberId, mcpServers } = useCanvasFrames();
  const server = mcpServers.get(id);
  const status = enabledMemberStatus(server !== undefined && !server.disabled);

  if (parentId !== undefined) {
    const expanded = expandedMemberId === id;

    return (
      <ResourceChip
        details={transportSubtitle(server)}
        expanded={expanded}
        icon={<Plug className="size-3.5" />}
        label={nodeData.label}
        mountable={false}
        nodeType="mcp"
        status={{
          color: status.color,
          text:
            server?.sandbox && !expanded
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
      subtitle={transportSubtitle(server)}
      liveStatus={status}
      showSideHandles={server?.transport === "machine"}
    />
  );
}

function transportSubtitle(
  server: StageMcpServer | undefined,
): string | undefined {
  if (server === undefined) return undefined;

  return server.sandbox
    ? `${server.sandbox} · stdio`
    : TRANSPORT_SUBTITLE[server.transport];
}
