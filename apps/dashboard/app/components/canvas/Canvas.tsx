"use client";

/** Main canvas component that renders nodes and edges from the database. */
import { CanvasControls } from "@/app/components/canvas/CanvasControl";
import { EmptyCanvasGuide } from "@/app/components/canvas/EmptyCanvasGuide";
import { AgentNode } from "@/app/components/node/Agent";
import { DatabaseNode } from "@/app/components/node/Database";
import { ToolNode } from "@/app/components/node/Tool";
import { WorkspaceNode } from "@/app/components/node/Workspace";
import { AgentSourcePickerDialog } from "@/app/components/AgentSourcePickerDialog";
import { CreateAgentConfigDialog } from "@/app/components/CreateAgentConfigDialog";
import { NodeSidePanel } from "@/app/components/NodeSidePanel";
import type { Id } from "@/convex/_generated/dataModel";
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
} from "@/app/components/ui/context-menu";
import { api } from "@/convex/_generated/api";
import { useEnvironment } from "@/app/lib/environment-context";
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
import { useQuery } from "convex/react";
import { Bot, Database, FolderOpen, Wrench } from "lucide-react";
import { useTheme } from "next-themes";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";

const nodeTypes = {
    agent: AgentNode,
    database: DatabaseNode,
    workspace: WorkspaceNode,
    tool: ToolNode,
};

const NODE_TEMPLATES = [
    { type: "agent", label: "Agent", icon: Bot },
    { type: "database", label: "Database", icon: Database },
    { type: "workspace", label: "Workspace", icon: FolderOpen },
    { type: "tool", label: "Tool", icon: Wrench },
] as const;

/** Inner canvas that consumes ReactFlow context. */
function CanvasInner({ projectId }: { projectId: Id<"projects"> }) {
    const { environmentId } = useEnvironment();
    const canvasLayout = useQuery(
        api.canvas.getByProject,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    );
    const { theme } = useTheme();
    const isDark = theme === "dark";

    const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
    const [selectedNode, setSelectedNode] = useState<Node | null>(null);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    const [configDialogOpen, setConfigDialogOpen] = useState(false);
    const { screenToFlowPosition } = useReactFlow();
    const nextId = useRef(1);
    const lastRightClick = useRef({ x: 0, y: 0 });

    // Sync nodes/edges from the database when layout data changes
    useEffect(() => {
        if (canvasLayout) {
            setNodes(canvasLayout.nodes as Node[]);
            setEdges(canvasLayout.edges as Edge[]);
            const maxId = canvasLayout.nodes.reduce(
                (max, n) => Math.max(max, Number(n.id) || 0),
                0,
            );
            nextId.current = maxId + 1;
        } else {
            setNodes([]);
            setEdges([]);
            nextId.current = 1;
        }
    }, [canvasLayout, setNodes, setEdges]);

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

    const addNodeAtPosition = useCallback(
        (type: string, label: string, position: { x: number; y: number }) => {
            const id = String(nextId.current++);
            const newNode: Node = {
                id: id,
                type: type,
                position: position,
                data: { label: `${label} ${id}`, status: "idle" },
            };
            setNodes((nds) => [...nds, newNode]);
        },
        [setNodes],
    );

    const addNode = useCallback(
        (type: string, label: string) => {
            addNodeAtPosition(type, label, lastRightClick.current);
        },
        [addNodeAtPosition],
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

    const isEmpty = nodes.length === 0;

    const flow = (
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
            colorMode={isDark ? "dark" : "light"}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{
                style: {
                    stroke: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)",
                    strokeWidth: 1.5,
                },
                animated: true,
            }}
        >
            <Background gap={24} size={1.5} color={isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"} />
            <Panel position="top-left">
                <CanvasControls />
            </Panel>
        </ReactFlow>
    );

    return (
        <div className="relative size-full overflow-hidden">
            {isEmpty ? (
                <div className="size-full">
                    {flow}
                </div>
            ) : (
                <ContextMenu>
                    <ContextMenuTrigger asChild>
                        <div className="size-full" onContextMenu={onContextMenu}>
                            {flow}
                        </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent
                        className="w-48 rounded-lg border border-border bg-card/80 p-1 backdrop-blur-md"
                    >
                        <ContextMenuLabel
                            className="text-xs tracking-wider text-muted-foreground pt-2!"
                        >
                            Add service
                        </ContextMenuLabel>
                        {NODE_TEMPLATES.map(({ type, label, icon: Icon }, index) => (
                            <Fragment key={type}>
                                {index === NODE_TEMPLATES.length - 1 && <ContextMenuSeparator />}
                                <ContextMenuItem
                                    onClick={() =>
                                        type === "agent"
                                            ? setSourcePickerOpen(true)
                                            : addNode(type, label)
                                    }
                                >
                                    <Icon />
                                    {label}
                                </ContextMenuItem>
                            </Fragment>
                        ))}
                    </ContextMenuContent>
                </ContextMenu>
            )}

            {isEmpty && (
                <EmptyCanvasGuide
                    onCreateConfig={() => setConfigDialogOpen(true)}
                />
            )}

            <NodeSidePanel node={selectedNode} onClose={() => setSelectedNode(null)} />

            <AgentSourcePickerDialog
                open={sourcePickerOpen}
                onOpenChange={setSourcePickerOpen}
                onCreateNew={() => setConfigDialogOpen(true)}
            />

            <CreateAgentConfigDialog
                projectId={projectId}
                environmentId={environmentId}
                open={configDialogOpen}
                onOpenChange={setConfigDialogOpen}
            />
        </div>
    );
}

/** Main canvas wrapped with ReactFlowProvider. */
export function Canvas({ projectId }: { projectId: Id<"projects"> }) {
    return (
        <ReactFlowProvider>
            <CanvasInner projectId={projectId} />
        </ReactFlowProvider>
    );
}
