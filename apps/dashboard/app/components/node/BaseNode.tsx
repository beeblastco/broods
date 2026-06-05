"use client";

import { JavaScript } from "@/app/components/icons/JavaScript";
import { Python } from "@/app/components/icons/Python";
import type { AgentHealthStatus } from "@/app/hooks/useAgentHealth";
import { Handle, Position, useStore } from "@xyflow/react";
import { Globe, Slash } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

export type AgentConnectivityMeta = {
    publicAccessEnabled: boolean;
    webSocketEnabled: boolean;
};

/** Shared node shell with handles, label, and status indicator. */
export function BaseNode({
    id,
    nodeType,
    data,
    icon,
    agentStatus,
    agentConnectivity,
    toolMeta,
    cardStatus,
    subtitle,
    featureRows,
}: {
    id: string;
    nodeType: string;
    data: BaseNodeData;
    icon: React.ReactNode;
    agentStatus?: AgentHealthStatus;
    agentConnectivity?: AgentConnectivityMeta;
    toolMeta?: ToolMeta;
    /** Binary enabled/disabled display for cards whose state mirrors a config `enabled` flag. */
    cardStatus?: { enabled: boolean };
    /** Optional secondary row rendered under the label (e.g. sandbox provider badge). */
    subtitle?: React.ReactNode;
    /** Optional list of `+ feature` rows rendered between label and status pill. */
    featureRows?: { key: string; icon?: React.ReactNode; label: string }[];
}) {
    const zoom = useStore(zoomSelector);
    const scale = Math.min(Math.max(1 / Math.sqrt(zoom), 0.9), 1.2);

    // The header content is counter-scaled to stay legible when zoomed out, but CSS
    // transforms don't reserve layout space — so we measure its unscaled height and
    // reserve `height * scale` on a wrapper, keeping it clear of the status pill.
    const contentRef = useRef<HTMLDivElement>(null);
    const [contentHeight, setContentHeight] = useState<number | null>(null);
    useEffect(() => {
        const el = contentRef.current;
        if (!el) return;

        const observer = new ResizeObserver(() => setContentHeight(el.offsetHeight));
        observer.observe(el);

        return () => observer.disconnect();
    }, []);

    const isConnectedToAgent = useStore(
        useCallback(
            (state: Record<string, unknown>) => {
                if (nodeType === "agent") return true;
                const edges = state.edges as Array<{ source: string; target: string }>;
                const nodeLookup = state.nodeLookup as Map<string, { type?: string }>;
                if (!edges || !nodeLookup) return false;

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
    } else if (cardStatus) {
        statusColor = cardStatus.enabled ? "bg-emerald-500" : "bg-red-400";
        statusText = cardStatus.enabled ? "Enabled" : "Disabled";
    } else {
        const config = statusConfig[data.status ?? "idle"];
        statusColor = config.color;
        statusText = config.text;
    }

    const borderClass = !isConnectedToAgent
        ? "border-red-400/40 hover:border-red-400/60"
        : "border-border hover:border-foreground/25";

    return (
        <div className={`relative w-44 min-h-24 flex flex-col rounded-md border bg-card transition-[border-color,box-shadow] duration-200 hover:shadow-md ${borderClass}`}>
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

            {nodeType === "agent" && (
                <span className="absolute top-2 right-2.5 z-10 inline-flex size-5 items-center justify-center rounded-full border border-border/70 bg-background/90">
                    <Globe className={`size-3.5 ${agentConnectivity?.publicAccessEnabled ? "text-emerald-500" : "text-muted-foreground"}`} />
                    {!agentConnectivity?.publicAccessEnabled && (
                        <Slash className="pointer-events-none absolute size-3.5 text-muted-foreground/80" />
                    )}
                </span>
            )}

            <div style={{ height: contentHeight != null ? contentHeight * scale : undefined }}>
                <div
                    ref={contentRef}
                    className="px-3 pt-2.5 origin-top-left"
                    style={{ transform: `scale(${scale})` }}
                >
                    <div className="flex items-center gap-1.5 pr-7 min-w-0">
                    {data.properties?.color ? (
                        <span
                            className="inline-block size-3 rounded-full shrink-0"
                            style={{ backgroundColor: data.properties.color }}
                        />
                    ) : (
                        <span className="text-muted-foreground shrink-0">{icon}</span>
                    )}
                    <span
                        className="text-xs font-medium text-foreground truncate min-w-0"
                        title={data.label}
                    >
                        {data.label}
                    </span>
                </div>
                {subtitle && (
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        {subtitle}
                    </div>
                )}
                    {featureRows && featureRows.length > 0 && (
                        <div className="mt-1.5 flex flex-col gap-0.5">
                            {featureRows.map((row) => (
                                <div
                                    key={row.key}
                                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                                >
                                    <span className="text-muted-foreground/60">+</span>
                                    {row.icon}
                                    <span>{row.label}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {showStatus && (
                <div className="mt-auto px-3 pt-2 pb-2.5 flex items-center gap-1.5">
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
