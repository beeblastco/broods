"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useEnvironment } from "@/app/hooks/useEnvironment";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { NodeProps } from "@xyflow/react";
import { useQuery } from "convex/react";
import { Wrench } from "lucide-react";
import { useParams } from "next/navigation";

/** Tool node representing an external tool on the canvas. */
export function ToolNode({ id, data }: NodeProps) {
  const { projectId } = useParams<{ projectId: string }>();
  const { environmentId } = useEnvironment();

  const toolService = useQuery(
    api.toolService.getByNode,
    projectId && environmentId
      ? {
          projectId: projectId as Id<"projects">,
          environmentId: environmentId,
          nodeId: id,
        }
      : "skip",
  );

  return (
    <BaseNode
      id={id}
      nodeType="tool"
      data={data as BaseNodeData}
      icon={<Wrench className="h-3.5 w-3.5" />}
      toolMeta={{
        language: toolService?.language ?? "javascript",
        status: toolService?.status ?? "enabled",
      }}
    />
  );
}
