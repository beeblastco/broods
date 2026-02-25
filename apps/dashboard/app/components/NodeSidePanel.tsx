"use client";

import { Separator } from "@/app/components/ui/separator";
import type { Node } from "@xyflow/react";
import { X } from "lucide-react";
import { type BaseNodeData, statusConfig } from "@/app/components/node/BaseNode";

/** Side panel that displays details for a selected canvas node. */
export function NodeSidePanel({
    node,
    onClose,
}: {
    node: Node | null;
    onClose: () => void;
}) {
    const nodeData = node?.data as BaseNodeData | undefined;
    const status: keyof typeof statusConfig = nodeData?.status ?? "idle";
    const { color, text } = statusConfig[status];

    return (
        <div
            className={`absolute right-0 top-0 z-10 flex h-full w-96 flex-col border-l border-border bg-card transition-transform duration-200 ease-out ${node ? "translate-x-0" : "translate-x-full"
                }`}
        >
            <div className="flex items-center justify-between px-4 py-3">
                <h2 className="text-sm font-medium text-foreground">Node Details</h2>
                <button
                    onClick={onClose}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                    <X className="h-4 w-4" />
                </button>
            </div>

            <Separator />

            {nodeData && (
                <div className="flex flex-1 flex-col gap-4 p-4">
                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</span>
                        <span className="text-sm text-foreground">{nodeData.label}</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Status</span>
                        <div className="flex items-center gap-2">
                            <div className={`h-2 w-2 rounded-full ${color}`} />
                            <span className="text-sm text-foreground">{text}</span>
                        </div>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Type</span>
                        <span className="text-sm text-foreground capitalize">{node?.type ?? "unknown"}</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">ID</span>
                        <span className="font-mono text-sm text-muted-foreground">{node?.id}</span>
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">Position</span>
                        <span className="font-mono text-sm text-muted-foreground">
                            x: {Math.round(node?.position.x ?? 0)}, y: {Math.round(node?.position.y ?? 0)}
                        </span>
                    </div>
                </div>
            )}
        </div>
    );
}
