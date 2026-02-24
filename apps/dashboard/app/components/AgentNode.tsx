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
    <div className="min-w-[180px] rounded-lg border border-white/10 bg-[#141414] shadow-lg shadow-black/20">
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-white/20 !border-white/10"
      />

      <div className="px-4 py-3">
        <p className="text-sm font-medium text-white/90">{nodeData.label}</p>
        <div className="mt-1.5 flex items-center gap-1.5">
          <div className={`w-1.5 h-1.5 rounded-full ${color}`} />
          <span className="text-xs text-white/40">{text}</span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-white/20 !border-white/10"
      />
    </div>
  );
}
