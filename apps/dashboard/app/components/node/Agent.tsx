"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

export type AgentNodeData = {
    label: string;
    status?: "running" | "idle" | "error";
};

const statusConfig = {
    running: { color: "bg-emerald-500", text: "Running" },
    idle: { color: "bg-zinc-500", text: "Idle" },
    error: { color: "bg-red-500", text: "Error" },
};

export function AgentNode({ data }: NodeProps) {
    const nodeData = data as AgentNodeData;
    const { color, text } = statusConfig[nodeData.status ?? "idle"];

    return (
        <div className="min-w-45 min-h-24 rounded-md border border-white/10 bg-[#141414] transition-[border-color,box-shadow] duration-200 hover:border-white/25 hover:shadow-[0_0_16px_rgba(255,255,255,0.06)]">
            <Handle
                type="target"
                position={Position.Top}
                className="bg-transparent! w-2.5! h-2.5! border-transparent!"
            />

            <div className="px-3 py-2.5 flex flex-col items-start justify-items-end gap-1 h-full">
                <div className="text-xs font-medium text-white/90">{nodeData.label}</div>
                <div className="mt-1 flex items-center gap-1.5">
                    <div className={`h-1.5 w-1.5 rounded-full ${color}`} />
                    <span className="text-[11px] text-white/40">{text}</span>
                </div>
            </div>

            < Handle
                type="source"
                position={Position.Bottom}
                className="bg-transparent! w-2.5! h-2.5! border-transparent!"
            />
        </div>
    );
}
