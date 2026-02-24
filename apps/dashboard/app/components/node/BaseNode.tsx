"use client";

import { Handle, Position, useStore } from "@xyflow/react";

export type BaseNodeData = {
    label: string;
    status?: "running" | "idle" | "error";
};

const statusConfig = {
    running: { color: "bg-emerald-500", text: "Running" },
    idle: { color: "bg-zinc-500", text: "Idle" },
    error: { color: "bg-red-500", text: "Error" },
};

const zoomSelector = (state: { transform: [number, number, number] }) => state.transform[2];

/** Shared node shell with handles, label, and status indicator. */
export function BaseNode({
    data,
    icon,
}: {
    data: BaseNodeData;
    icon: React.ReactNode;
}) {
    const zoom = useStore(zoomSelector);
    const scale = Math.min(Math.max(1 / Math.sqrt(zoom), 0.9), 1.2);
    const { color, text } = statusConfig[data.status ?? "idle"];

    return (
        <div className="min-w-45 min-h-24 rounded-md border border-white/10 bg-[#141414] transition-[border-color,box-shadow] duration-200 hover:border-white/25 hover:shadow-[0_0_16px_rgba(255,255,255,0.06)]">
            <Handle
                type="target"
                position={Position.Top}
                className="bg-transparent! w-2.5! h-2.5! border-transparent!"
            />

            <div
                className="px-3 py-2.5 flex flex-col items-start gap-1 h-full origin-top-left"
                style={{ transform: `scale(${scale})` }}
            >
                <div className="flex items-center gap-1.5">
                    <span className="text-white/40">{icon}</span>
                    <span className="text-xs font-medium text-white/90 whitespace-nowrap">{data.label}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                    <div className={`h-1.5 w-1.5 rounded-full ${color}`} />
                    <span className="text-[11px] text-white/40">{text}</span>
                </div>
            </div>

            <Handle
                type="source"
                position={Position.Bottom}
                className="bg-transparent! w-2.5! h-2.5! border-transparent!"
            />
        </div>
    );
}
