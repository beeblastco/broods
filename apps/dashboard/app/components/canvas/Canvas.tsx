"use client";

import { CanvasControls } from "@/app/components/canvas/CanvasControl";
import { AgentNode } from "@/app/components/node/Agent";
import { DatabaseNode } from "@/app/components/node/Database";
import { ToolNode } from "@/app/components/node/Tool";
import { WorkspaceNode } from "@/app/components/node/Workspace";
import { NodeSidePanel } from "@/app/components/NodeSidePanel";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/app/components/ui/context-menu";
import {
    addEdge,
    Background,
    Panel,
    ReactFlow,
    ReactFlowProvider,
    useEdgesState,
    useNodesState,
    useReactFlow,
    type Edge,
    type Node,
    type NodeMouseHandler,
    type OnConnect,
} from "@xyflow/react";
import { Bot, Database, FolderOpen, Wrench } from "lucide-react";
import { useCallback, useRef, useState } from "react";

const nodeTypes = {
    agent: AgentNode,
    database: DatabaseNode,
    workspace: WorkspaceNode,
    tool: ToolNode,
};

const initialNodes: Node[] = [
    {
        id: "1",
        type: "agent",
        position: { x: 250, y: 100 },
        data: { label: "Orchestrator", status: "running" },
    },
    {
        id: "2",
        type: "agent",
        position: { x: 100, y: 300 },
        data: { label: "Research Agent", status: "running" },
    },
    {
        id: "3",
        type: "agent",
        position: { x: 400, y: 300 },
        data: { label: "Writer Agent", status: "idle" },
    },
];

const initialEdges: Edge[] = [
    { id: "e1-2", source: "1", target: "2", animated: true },
    { id: "e1-3", source: "1", target: "3", animated: true },
];

/** Inner canvas that consumes ReactFlow context. */
function CanvasInner() {
    const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
    const [selectedNode, setSelectedNode] = useState<Node | null>(null);
    const { screenToFlowPosition } = useReactFlow();
    const nextId = useRef(initialNodes.length + 1);
    const lastRightClick = useRef({ x: 0, y: 0 });

    const onConnect: OnConnect = useCallback(
        (params) => setEdges((eds) => addEdge(params, eds)),
        [setEdges],
    );

    const onContextMenu = useCallback(
        (event: React.MouseEvent) => {
            lastRightClick.current = screenToFlowPosition({
                x: event.clientX,
                y: event.clientY,
            });
        },
        [screenToFlowPosition],
    );

    const addNode = useCallback(
        (type: string, label: string) => {
            const id = String(nextId.current++);
            const newNode: Node = {
                id: id,
                type: type,
                position: lastRightClick.current,
                data: { label: `${label} ${id}`, status: "idle" },
            };
            setNodes((nds) => [...nds, newNode]);
        },
        [setNodes],
    );

    const onNodeClick: NodeMouseHandler = useCallback(
        (_event, node) => {
            setSelectedNode(node);
        },
        [],
    );

    const onPaneClick = useCallback(() => {
        setSelectedNode(null);
    }, []);

    return (
        <div className="relative size-full overflow-hidden">
            <ContextMenu>
                <ContextMenuTrigger asChild>
                    <div className="size-full" onContextMenu={onContextMenu}>
                        <ReactFlow
                            nodes={nodes}
                            edges={edges}
                            onNodesChange={onNodesChange}
                            onEdgesChange={onEdgesChange}
                            onConnect={onConnect}
                            onNodeClick={onNodeClick}
                            onPaneClick={onPaneClick}
                            nodeTypes={nodeTypes}
                            fitView
                            fitViewOptions={{ maxZoom: 1.5, padding: 1 }}
                            maxZoom={1.5}
                            colorMode="dark"
                            proOptions={{ hideAttribution: true }}
                            defaultEdgeOptions={{
                                style: { stroke: "rgba(255,255,255,0.15)", strokeWidth: 1.5 },
                                animated: true,
                            }}
                        >
                            <Background gap={24} size={1.5} color="rgba(255,255,255,0.08)" />
                            <Panel position="top-left">
                                <CanvasControls />
                            </Panel>
                        </ReactFlow>
                    </div>
                </ContextMenuTrigger>
                <ContextMenuContent
                    className="w-48 rounded-lg border border-white/10 bg-[#141414]/80 p-1 backdrop-blur-md"
                >
                    <ContextMenuLabel
                        className="text-xs tracking-wider text-muted-foreground pt-2!"
                    >
                        Add service
                    </ContextMenuLabel>
                    <ContextMenuItem onClick={() => addNode("agent", "Agent")}>
                        <Bot />
                        Agent
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => addNode("database", "Database")}>
                        <Database />
                        Database
                    </ContextMenuItem>
                    <ContextMenuItem onClick={() => addNode("workspace", "Workspace")}>
                        <FolderOpen />
                        Workspace
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onClick={() => addNode("tool", "Tool")}>
                        <Wrench />
                        Tool
                    </ContextMenuItem>
                </ContextMenuContent>
            </ContextMenu>

            <NodeSidePanel node={selectedNode} onClose={() => setSelectedNode(null)} />
        </div>
    );
}

/** Main canvas wrapped with ReactFlowProvider. */
// Must be separate from CanvasInner to avoid breaking ReactFlow context in the side panel.
export function Canvas() {
    return (
        <ReactFlowProvider>
            <CanvasInner />
        </ReactFlowProvider>
    );
}
