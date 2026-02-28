"use client";

import { JavaScript } from "@/app/components/icons/JavaScript";
import { Python } from "@/app/components/icons/Python";
import type { AgentHealthStatus } from "@/app/hooks/useAgentHealth";
import { Handle, Position, useStore } from "@xyflow/react";
import { useCallback } from "react";

export type BaseNodeData = {
    label: string;
    status?: "running" | "idle" | "error";
    agentConfigId?: string;
    properties?: { color: string };
};

export const statusConfig = {
    running: { color: "bg-emerald-500", text: "Running" },
    idle: { color: "bg-zinc-500", text: "Idle" },
    error: { color: "bg-red-500", text: "Error" },
};

/** Status display config for agent health states. */
export const agentStatusConfig: Record<AgentHealthStatus, { color: string; text: string }> = {
    healthy: { color: "bg-emerald-500", text: "Healthy" },
    deploying: { color: "bg-amber-500", text: "Deploying" },
    idle: { color: "bg-zinc-500", text: "Idle" },
    unhealthy: { color: "bg-red-500", text: "Unhealthy" },
};

const zoomSelector = (state: { transform: [number, number, number] }) => state.transform[2];

export type ToolMeta = {
    language: "javascript" | "python";
    status: "enabled" | "disabled";
};

/** Shared node shell with handles, label, and status indicator. */
export function BaseNode({
    id,
    nodeType,
    data,
    icon,
    agentStatus,
    toolMeta,
}: {
    id: string;
    nodeType: string;
    data: BaseNodeData;
    icon: React.ReactNode;
    agentStatus?: AgentHealthStatus;
    toolMeta?: ToolMeta;
}) {
    const zoom = useStore(zoomSelector);
    const scale = Math.min(Math.max(1 / Math.sqrt(zoom), 0.9), 1.2);

    const isConnectedToAgent = useStore(
        useCallback(
            (state: Record<string, unknown>) => {
                if (nodeType === "agent") return true;
                const edges = state.edges as Array<{ source: string; target: string }>;
                const nodeLookup = state.nodeLookup as Map<string, { type?: string }>;
                if (!edges || !nodeLookup) return false;

                // Only check edges that involve this node
                for (const e of edges) {
                    if (e.source !== id && e.target !== id) continue;
                    const otherNodeId = e.source === id ? e.target : e.source;
                    const otherNode = nodeLookup.get(otherNodeId);
                    if (otherNode?.type === "agent") return true;
                }

                return false;
            },
            [id, nodeType],
        ),
    );

    let statusColor = "";
    let statusText = "";
    let showStatus = true;

    if (nodeType === "tool") {
        if (toolMeta) {
            statusColor = toolMeta.status === "enabled" ? "bg-emerald-500" : "bg-zinc-500";
            statusText = toolMeta.status === "enabled" ? "Enabled" : "Disabled";
        } else {
            showStatus = false;
        }
    } else if (nodeType === "agent" && agentStatus) {
        const config = agentStatusConfig[agentStatus];
        statusColor = config.color;
        statusText = config.text;
    } else if (nodeType === "database") {
        if (isConnectedToAgent) {
            statusColor = "bg-emerald-500";
            statusText = "Connected";
        } else {
            statusColor = "bg-red-400";
            statusText = "Disconnected";
        }
    } else if (!isConnectedToAgent) {
        statusColor = "bg-red-400";
        statusText = "Unconnected";
    } else {
        const config = statusConfig[data.status ?? "idle"];
        statusColor = config.color;
        statusText = config.text;
    }

    const borderClass = !isConnectedToAgent
        ? "border-red-400/40 hover:border-red-400/60"
        : "border-border hover:border-foreground/25";

    return (
        <div className={`relative min-w-45 min-h-24 flex flex-col rounded-md border bg-card transition-[border-color,box-shadow] duration-200 hover:shadow-md ${borderClass}`}>
            <Handle
                type="target"
                position={Position.Top}
                className="bg-transparent! w-2.5! h-2.5! border-transparent!"
            />

            {toolMeta && (
                <span className="absolute top-2 right-2.5 z-10">
                    {toolMeta.language === "python" ? (
                        <Python className="size-3.5" />
                    ) : (
                        <JavaScript className="size-3.5" />
                    )}
                </span>
            )}

            <div
                className="px-3 pt-2.5 origin-top-left"
                style={{ transform: `scale(${scale})` }}
            >
                <div className="flex items-center gap-1.5">
                    {data.properties?.color ? (
                        <span
                            className="inline-block size-3 rounded-full shrink-0"
                            style={{ backgroundColor: data.properties.color }}
                        />
                    ) : (
                        <span className="text-muted-foreground">{icon}</span>
                    )}
                    <span className="text-xs font-medium text-foreground whitespace-nowrap">{data.label}</span>
                </div>
            </div>

            {showStatus && (
                <div className="mt-auto px-3 pb-2.5 flex items-center gap-1.5">
                    <div className={`h-1.5 w-1.5 rounded-full ${statusColor}`} />
                    <span className="text-[11px] text-muted-foreground">{statusText}</span>
                </div>
            )}

            <Handle
                type="source"
                position={Position.Bottom}
                className="bg-transparent! w-2.5! h-2.5! border-transparent!"
            />
        </div>
    );
}
