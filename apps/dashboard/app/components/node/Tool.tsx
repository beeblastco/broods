"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { useStage } from "@/app/hooks/useStage";
import { api } from "@broods/convex/_generated/api";
import type { Id } from "@broods/convex/_generated/dataModel";
import type { NodeProps } from "@xyflow/react";
import { useQuery } from "convex/react";
import { Wrench } from "lucide-react";
import { useParams } from "next/navigation";

/** Tool node representing an external tool on the canvas. */
export function ToolNode({ id, data }: NodeProps) {
  const { projectId } = useParams<{ projectId: string }>();
  const { stageId } = useStage();

  const toolService = useQuery(
    api.toolService.getByNode,
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
      nodeType="tool"
      data={data as BaseNodeData}
      icon={<Wrench className="size-3.5" />}
      toolMeta={{
        language: "javascript",
        status: toolService?.disabled === true ? "disabled" : "enabled",
      }}
    />
  );
}
