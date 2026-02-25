"use client";

/** Locked, non-interactive React Flow canvas preview for project cards. */
import { AgentNode } from "@/app/components/node/Agent";
import { DatabaseNode } from "@/app/components/node/Database";
import { ToolNode } from "@/app/components/node/Tool";
import { WorkspaceNode } from "@/app/components/node/Workspace";
import {
    Background,
    ReactFlow,
    ReactFlowProvider,
    type Edge,
    type Node,
} from "@xyflow/react";
import { useTheme } from "next-themes";

type CanvasNode = {
    id: string;
    type: "agent" | "database" | "workspace" | "tool";
    position: { x: number; y: number };
    data: { label: string; status?: "running" | "idle" | "error" };
};

type CanvasEdge = {
    id: string;
    source: string;
    target: string;
    animated?: boolean;
};

const nodeTypes = {
    agent: AgentNode,
    database: DatabaseNode,
    workspace: WorkspaceNode,
    tool: ToolNode,
};

/** Inner React Flow preview — must be inside a ReactFlowProvider. */
function PreviewInner({
    nodes,
    edges,
}: {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
}) {
    const { resolvedTheme } = useTheme();
    const isDark = resolvedTheme === "dark";

    return (
        <ReactFlow
            nodes={nodes as Node[]}
            edges={edges as Edge[]}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 0.6 }}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            colorMode={isDark ? "dark" : "light"}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
                style: {
                    stroke: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)",
                    strokeWidth: 1.5,
                },
            }}
        >
            <Background
                gap={24}
                size={1.5}
                color={isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"}
            />
        </ReactFlow>
    );
}

/** Renders a locked React Flow canvas preview with real node components. */
export function CanvasPreview({
    canvas,
}: {
    canvas: { nodes: CanvasNode[]; edges: CanvasEdge[] } | null;
}) {
    if (!canvas || canvas.nodes.length === 0) {
        return (
            <div className="flex h-full w-full items-center justify-center">
                <p className="text-xs text-muted-foreground/40">No architecture yet</p>
            </div>
        );
    }

    return (
        <ReactFlowProvider>
            <PreviewInner nodes={canvas.nodes} edges={canvas.edges} />
        </ReactFlowProvider>
    );
}
