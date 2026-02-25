"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { Database } from "lucide-react";

/** Database node representing a data store on the canvas. */
export function DatabaseNode({ data }: NodeProps) {
    return <BaseNode data={data as BaseNodeData} icon={<Database className="h-3.5 w-3.5" />} />;
}
