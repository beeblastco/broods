"use client";

import { JavaScript } from "@/app/components/icons/JavaScript";
import { Python } from "@/app/components/icons/Python";
import type { AgentHealthStatus } from "@/app/hooks/useAgentHealth";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import { Handle, Position, useConnection, useStore } from "@xyflow/react";
import { CornerDownRight, Globe, Lock, Slash, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

export type BaseNodeData = {
    label: string;
    status?: "running" | "idle" | "error";
    agentConfigId?: string;
    resourceId?: string;
    mountName?: string;
    description?: string;
    config?: Record<string, unknown>;
    properties?: { color: string };
    // CLI-resolved forced read-only state for a workspace node (e.g. a `sandbox: null`
    // ref with no other writer). The pure-canvas graph can't express it, so analysis
    // honors this flag over the topology-inferred "inherited" state.
    readOnly?: boolean;
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
    cardStatus,
    subtitle,
    featureRows,
    showSideHandles,
}: {
    id: string;
    nodeType: string;
    data: BaseNodeData;
    icon: React.ReactNode;
    agentStatus?: AgentHealthStatus;
    toolMeta?: ToolMeta;
    /** Binary enabled/disabled display for cards whose state mirrors a config `enabled` flag. */
    cardStatus?: { enabled: boolean };
    /** Optional secondary row rendered under the label (e.g. sandbox provider badge). */
    subtitle?: React.ReactNode;
    /** Optional list of `+ feature` rows rendered between label and status pill. */
    featureRows?: { key: string; icon?: React.ReactNode; label: string }[];
    /** Render left/right handles for mount connections (workspace ↔ sandbox). */
    showSideHandles?: boolean;
}) {
    const zoom = useStore(zoomSelector);
    const scale = Math.min(Math.max(1 / Math.sqrt(zoom), 0.9), 1.2);

    // Side handles must stay mounted at all times — existing mount/subagent edges attach to
    // them, and ReactFlow drops any edge whose handle disappears (edges used to vanish
    // mid-drag). Instead we gate `isConnectableEnd` so mid-drag only the sides matching the
    // drag's intent accept the drop: workspace/sandbox sides serve mounts; agent sides serve
    // subagent (agent↔agent) links. Plain agent→service edges still land on the top handle.
    const sideHandlesConnectable = useConnection((connection) => {
        if (!connection.inProgress) return true;
        const fromType = connection.fromNode?.type;
        const fromSide = connection.fromHandle?.id === "left" || connection.fromHandle?.id === "right";

        // Gate by THIS node's type so the two side-handle relationships stay isolated: an agent's
        // sides serve only subagent links (another agent dragging from a side), and a
        // workspace/sandbox's sides serve only mounts. This way an agent never accepts an edge
        // during a mount drag, and a service never does during a subagent drag.
        if (nodeType === "agent") return fromType === "agent" && fromSide;

        return fromType === "workspace" || fromType === "sandbox";
    });

    // Infra badges: workspace effective-sandbox state (B) and shared-agent count (F).
    const infraAnalysis = useInfraAnalysis();
    const workspaceState = nodeType === "workspace" ? infraAnalysis.workspaceStates[id] : undefined;
    const sharedAgentCount =
        nodeType === "workspace" || nodeType === "sandbox" ? infraAnalysis.agentRefCounts[id] ?? 0 : 0;

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

                if (nodeType === "workspace" || nodeType === "sandbox") {
                    const visited = new Set<string>([id]);
                    const queue = [id];
                    while (queue.length > 0) {
                        const current = queue.shift()!;
                        for (const edge of edges) {
                            if (edge.source !== current && edge.target !== current) continue;
                            const otherNodeId = edge.source === current ? edge.target : edge.source;
                            if (visited.has(otherNodeId)) continue;
                            visited.add(otherNodeId);
                            const otherNode = nodeLookup.get(otherNodeId);
                            if (otherNode?.type === "agent") return true;
                            if (otherNode?.type === "workspace" || otherNode?.type === "sandbox") {
                                queue.push(otherNodeId);
                            }
                        }
                    }

                    return false;
                }

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
        // Conversation persistence is always on once wired to an agent (the session store).
        if (isConnectedToAgent) {
            statusColor = "bg-emerald-500";
            statusText = "Persistent";
        } else {
            statusColor = "bg-red-400";
            statusText = "Unconnected";
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
            {/* The explicit id matters: while connecting, xyflow resolves an id-less hovered
                handle to the node's FIRST handle (sources before targets) for the snap preview,
                which is the left side handle — the line would visually snap to the side even
                though the connection itself lands here on top. */}
            <Handle
                id="top"
                type="target"
                position={Position.Top}
                isConnectableStart={false}
                className="bg-transparent! w-2.5! h-2.5! border-transparent!"
            />

            {/* Agents source downward edges to services. Declared before the side handles so this
                no-id handle is the first source bound — xyflow resolves a handle-less edge to the
                first source handle, so plain agent→service edges land here, not on a side. */}
            {nodeType === "agent" && (
                <Handle
                    type="source"
                    position={Position.Bottom}
                    isConnectableEnd={false}
                    className="bg-transparent! w-2.5! h-2.5! border-transparent!"
                />
            )}

            {showSideHandles && (
                <>
                    <Handle
                        id="left"
                        type="source"
                        position={Position.Left}
                        isConnectableEnd={sideHandlesConnectable}
                        className="bg-transparent! w-2.5! h-2.5! border-transparent!"
                    />
                    <Handle
                        id="right"
                        type="source"
                        position={Position.Right}
                        isConnectableEnd={sideHandlesConnectable}
                        className="bg-transparent! w-2.5! h-2.5! border-transparent!"
                    />
                </>
            )}

            {toolMeta && (
                <span className="absolute top-2 right-2.5 z-10">
                    {toolMeta.language === "python" ? (
                        <Python className="size-3.5" />
                    ) : (
                        <JavaScript className="size-3.5" />
                    )}
                </span>
            )}

            {(nodeType === "agent" || nodeType === "sandbox") && (
                <span className="absolute top-2 right-2.5 z-10 inline-flex size-5 items-center justify-center rounded-full border border-border/70 bg-background/90">
                    <Globe
                        className={`size-3.5 ${
                            nodeType === "sandbox"
                                ? data.config?.internet === true
                                    ? "text-emerald-500"
                                    : "text-muted-foreground"
                                : "text-emerald-500"
                        }`}
                    />
                    {nodeType === "sandbox" && data.config?.internet !== true && (
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

                    {/* B — workspace effective-sandbox state from the cascade */}
                    {workspaceState && (
                        <div className="mt-1.5 flex items-center gap-1.5 text-[11px] min-w-0">
                            {workspaceState.kind === "readonly" ? (
                                <>
                                    <Lock className="size-3 shrink-0 text-amber-500/80" />
                                    <span className="text-amber-500/90">read-only</span>
                                </>
                            ) : workspaceState.kind === "override" ? (
                                <>
                                    <CornerDownRight className="size-3 shrink-0 text-teal-500/80" />
                                    <span className="truncate text-teal-500/90" title={workspaceState.sandboxLabels.join(", ")}>
                                        {workspaceState.sandboxLabels.join(", ")}
                                    </span>
                                    <span className="shrink-0 text-muted-foreground/60">· mounted</span>
                                </>
                            ) : (
                                <>
                                    <CornerDownRight className="size-3 shrink-0 text-muted-foreground/70" />
                                    <span className="truncate text-muted-foreground" title={workspaceState.sandboxLabel}>
                                        {workspaceState.sandboxLabel}
                                    </span>
                                    <span className="shrink-0 text-muted-foreground/60">· inherited</span>
                                </>
                            )}
                        </div>
                    )}

                    {/* F — shared across multiple agents */}
                    {sharedAgentCount >= 2 && (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Users className="size-3 shrink-0" />
                            <span>shared ×{sharedAgentCount}</span>
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

        </div>
    );
}
