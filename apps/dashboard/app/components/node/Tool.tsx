"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { Wrench } from "lucide-react";

/** Tool node representing an external tool on the canvas. */
export function ToolNode({ id, data }: NodeProps) {
    return <BaseNode id={id} nodeType="tool" data={data as BaseNodeData} icon={<Wrench className="h-3.5 w-3.5" />} />;
}
