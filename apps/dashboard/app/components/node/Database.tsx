"use client";

import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import type { NodeProps } from "@xyflow/react";
import { Database } from "lucide-react";

/** Session node — the agent's persistent conversation store (pruning/compaction tuned in its panel). */
export function DatabaseNode({ id, data }: NodeProps) {
    return (
        <BaseNode
            id={id}
            nodeType="database"
            data={data as BaseNodeData}
            icon={<Database className="h-3.5 w-3.5" />}
            subtitle={<span className="text-[11px] text-muted-foreground">Conversation store</span>}
        />
    );
}
