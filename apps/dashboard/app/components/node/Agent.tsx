"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { Bot } from "lucide-react";

/** Agent node representing an AI agent on the canvas. */
export function AgentNode({ data }: NodeProps) {
    return <BaseNode data={data as BaseNodeData} icon={<Bot className="h-3.5 w-3.5" />} />;
}
