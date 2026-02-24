"use client";

import { Separator } from "@/app/components/ui/separator";
import type { Node } from "@xyflow/react";
import { X } from "lucide-react";

type AgentNodeData = {
    label: string;
    status?: "running" | "idle" | "error";
};

const statusConfig = {
    running: { color: "bg-emerald-500", text: "Running" },
    idle: { color: "bg-zinc-500", text: "Idle" },
    error: { color: "bg-red-500", text: "Error" },
};

/** Side panel that displays details for a selected canvas node. */
export function NodeSidePanel({
    node,
    onClose,
}: {
    node: Node | null;
    onClose: () => void;
}) {
    const nodeData = node?.data as AgentNodeData | undefined;
    const status = nodeData?.status ?? "idle";
    const { color, text } = statusConfig[status];

    return (
        <div
            className={`absolute right-0 top-0 z-10 flex h-full w-96 flex-col border-l border-white/10 bg-[#141414] transition-transform duration-200 ease-out ${node ? "translate-x-0" : "translate-x-full"
                }`}
        >
            <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-medium text-white/90">Node Details</h2>
                <button
                    onClick={onClose}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-white/40 transition-colors hover:bg-white/5 hover:text-white/70"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            <Separator className="bg-white/10" />

            {nodeData && (
                <div className="flex flex-1 flex-col gap-4 p-4">
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-white/30">Name</span>
                        <span className="text-sm text-white/80">{nodeData.label}</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-white/30">Status</span>
                        <div className="flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${color}`} />
                            <span className="text-sm text-white/80">{text}</span>
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-white/30">Type</span>
                        <span className="text-sm text-white/80 capitalize">{node?.type ?? "unknown"}</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-white/30">ID</span>
                        <span className="font-mono text-sm text-white/50">{node?.id}</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-white/30">Position</span>
                        <span className="font-mono text-sm text-white/50">
                            x: {Math.round(node?.position.x ?? 0)}, y: {Math.round(node?.position.y ?? 0)}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
