"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useStage } from "@/app/hooks/useStage";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { NodeProps } from "@xyflow/react";
import { useQuery } from "convex/react";
import { Plug } from "lucide-react";
import { useParams } from "next/navigation";

/** MCP server node: one registered server exposing its tools to wired agents. */
export function McpNode({ id, data }: NodeProps): React.JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  const { stageId } = useStage();

  const server = useQuery(
    api.mcpService.getByNode,
    projectId && stageId
      ? {
          projectId: projectId as Id<"projects">,
          stageId: stageId,
          nodeId: id,
        }
      : "skip",
  );

  return (
    <BaseNode
      id={id}
      nodeType="mcp"
      data={data as BaseNodeData}
      icon={<Plug className="size-3.5" />}
      subtitle={
        server
          ? server.transport === "hosted"
            ? "hosted · node"
            : "external · url"
          : undefined
      }
      cardStatus={{ enabled: !!server && server.disabled !== true }}
    />
  );
}
