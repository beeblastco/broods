"use client";

/** Main canvas component that renders nodes and edges from the database. */
import { CanvasControls } from "@/app/components/canvas/CanvasControl";
import { DeletableEdge } from "@/app/components/canvas/DeletableEdge";
import { EmptyCanvasGuide } from "@/app/components/canvas/EmptyCanvasGuide";
import { AgentNode } from "@/app/components/node/Agent";
import { DatabaseNode } from "@/app/components/node/Database";
import { ToolNode } from "@/app/components/node/Tool";
import { WorkspaceNode } from "@/app/components/node/Workspace";
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
import { useEnvironment } from "@/app/hooks/useEnvironment";
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
import { useMutation, useQuery } from "convex/react";
import { Bot, Database, FolderOpen, Wrench } from "lucide-react";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

// Defer interaction-only components to reduce initial bundle size.
const NodeSidePanel = dynamic(
    () => import("@/app/components/NodeSidePanel").then((mod) => mod.NodeSidePanel),
    { loading: () => <div className="absolute right-0 top-0 z-10 h-full w-1/3" /> },
);
const AgentSourcePickerDialog = dynamic(
    () => import("@/app/components/AgentSourcePickerDialog").then((mod) => mod.AgentSourcePickerDialog),
);
const CreateAgentConfigDialog = dynamic(
    () => import("@/app/components/CreateAgentConfigDialog").then((mod) => mod.CreateAgentConfigDialog),
);
const ToolSourcePickerDialog = dynamic(
    () => import("@/app/components/ToolSourcePickerDialog").then((mod) => mod.ToolSourcePickerDialog),
);

const nodeTypes = {
    agent: AgentNode,
    database: DatabaseNode,
    workspace: WorkspaceNode,
    tool: ToolNode,
};

const edgeTypes = {
    default: DeletableEdge,
};

const NODE_TEMPLATES = [
    { type: "agent", label: "Agent", icon: Bot },
    { type: "database", label: "Database", icon: Database },
    { type: "workspace", label: "Workspace", icon: FolderOpen },
    { type: "tool", label: "Tool", icon: Wrench },
] as const;

/** Static ReactFlow options hoisted outside components to avoid object churn on re-renders. */
const FIT_VIEW_OPTIONS = { maxZoom: 1.5, padding: 1 } as const;
const PRO_OPTIONS = { hideAttribution: true } as const;

/** Find the nearest agent node to a given flow position. */
function findNearestAgentNode(
    nodes: Node[],
    position: { x: number; y: number },
): Node | null {
    let nearest: Node | null = null;
    let nearestDist = Infinity;

    for (const node of nodes) {
        if (node.type !== "agent") continue;
        const dist = Math.hypot(node.position.x - position.x, node.position.y - position.y);
        if (dist < nearestDist) {
            nearest = node;
            nearestDist = dist;
        }
    }

    return nearest;
}

/** Inner canvas that consumes ReactFlow context. */
function CanvasInner({ projectId }: { projectId: Id<"projects"> }) {
    const { environmentId } = useEnvironment();
    const canvasLayout = useQuery(
        api.canvas.getByProject,
        environmentId ? { projectId: projectId, environmentId: environmentId } : "skip",
    );
    const { theme } = useTheme();
    const isDark = theme === "dark";

    const defaultEdgeOptions = useMemo(
        () => ({
            style: {
                stroke: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.15)",
                strokeWidth: 1.5,
            },
            animated: true,
        }),
        [isDark],
    );

    const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
    const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
    const [selectedNode, setSelectedNode] = useState<Node | null>(null);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    const [toolPickerOpen, setToolPickerOpen] = useState(false);
    const [configDialogOpen, setConfigDialogOpen] = useState(false);
    const { screenToFlowPosition } = useReactFlow();
    const nextId = useRef(1);
    const lastRightClick = useRef({ x: 0, y: 0 });
    const nodesRef = useRef(nodes);
    const edgesRef = useRef(edges);

    useEffect(() => {
        nodesRef.current = nodes;
        edgesRef.current = edges;
    }, [nodes, edges]);
    const saveLayoutMutation = useMutation(api.canvas.saveLayout);
    const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hasLocalChanges = useRef(false);

    /** Debounced save — writes current local state to the database after 500ms of inactivity. */
    const scheduleSave = useCallback(() => {
        hasLocalChanges.current = true;
        if (debounceTimer.current) clearTimeout(debounceTimer.current);
        debounceTimer.current = setTimeout(() => {
            if (!environmentId) return;
            saveLayoutMutation({
                projectId: projectId,
                environmentId: environmentId,
                nodes: nodesRef.current.map((n) => ({
                    id: n.id,
                    type: n.type as "agent" | "database" | "workspace" | "tool",
                    position: n.position,
                    data: n.data as {
                        label: string;
                        status?: "running" | "idle" | "error";
                        agentConfigId?: Id<"agentConfigs">;
                        properties?: { color: string };
                    },
                })),
                edges: edgesRef.current.map((e) => ({
                    id: e.id,
                    source: e.source,
                    target: e.target,
                    animated: e.animated,
                })),
            }).finally(() => {
                hasLocalChanges.current = false;
            });
        }, 500);
    }, [environmentId, projectId, saveLayoutMutation]);

    // Cleanup debounce timer on unmount
    useEffect(() => {
        return () => {
            if (debounceTimer.current) clearTimeout(debounceTimer.current);
        };
    }, []);

    // Sync nodes/edges from the database — skip when local changes are pending
    useEffect(() => {
        if (hasLocalChanges.current) return;

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
        (params) => {
            setEdges((eds) => addEdge(params, eds));
            scheduleSave();
        },
        [setEdges, scheduleSave],
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

    /** Add a service node at a position and auto-connect to the nearest agent. */
    const addNode = useCallback(
        (type: string, label: string) => {
            const position = lastRightClick.current;
            const id = String(nextId.current++);
            const nodeLabel = `${label} ${id}`;

            const newNode: Node = {
                id: id,
                type: type,
                position: position,
                data: { label: nodeLabel, status: "idle" },
            };
            setNodes((nds) => [...nds, newNode]);

            // Auto-connect to nearest agent node
            const nearest = findNearestAgentNode(nodesRef.current, position);
            if (nearest) {
                const newEdge: Edge = {
                    id: `e${nearest.id}-${id}`,
                    source: nearest.id,
                    target: id,
                };
                setEdges((eds) => [...eds, newEdge]);
            }

            scheduleSave();
        },
        [setNodes, setEdges, scheduleSave],
    );

    /** Save after a node drag completes. */
    const onNodeDragStop: NodeMouseHandler = useCallback(() => {
        scheduleSave();
    }, [scheduleSave]);

    /** Persist and close side panel when nodes are deleted via keyboard/context actions. */
    const onNodesDelete = useCallback(() => {
        setSelectedNode(null);
        scheduleSave();
    }, [scheduleSave]);

    const onNodeClick: NodeMouseHandler = useCallback(
        (_event, node) => {
            setSelectedNode(node);
        },
        [],
    );

    const onPaneClick = useCallback(() => setSelectedNode(null), []);
    const onOpenCreateConfig = useCallback(() => setConfigDialogOpen(true), []);

    /** Wrapper matching OnEdgesDelete signature. */
    const onEdgesDeleteHandler = useCallback(() => {
        scheduleSave();
    }, [scheduleSave]);

    /** Stable handler for tool source picker selection. */
    const onToolSelect = useCallback(() => {
        // TODO: handle "docker" and "upload" sources with dedicated flows
        addNode("tool", "Tool");
    }, [addNode]);

    /** Remove a node and its connected edges from the canvas. */
    const removeNode = useCallback(
        (nodeId: string) => {
            setNodes((nds) => nds.filter((n) => n.id !== nodeId));
            setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
            setSelectedNode(null);
            scheduleSave();
        },
        [setNodes, setEdges, scheduleSave],
    );

    /** Update a node's label in the canvas layout. */
    const updateNodeLabel = useCallback(
        (nodeId: string, label: string) => {
            setNodes((nds) =>
                nds.map((n) =>
                    n.id === nodeId ? { ...n, data: { ...n.data, label: label } } : n,
                ),
            );
            scheduleSave();
        },
        [setNodes, scheduleSave],
    );

    const isLoading = canvasLayout === undefined;
    const isEmpty = !isLoading && nodes.length === 0;

    const flow = (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onNodesDelete={onNodesDelete}
            onEdgesDelete={onEdgesDeleteHandler}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            maxZoom={1.5}
            colorMode={isDark ? "dark" : "light"}
            proOptions={PRO_OPTIONS}
            defaultEdgeOptions={defaultEdgeOptions}
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
                                            : type === "tool"
                                              ? setToolPickerOpen(true)
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
                    onCreateConfig={onOpenCreateConfig}
                />
            )}

            <NodeSidePanel
                node={selectedNode}
                onClose={onPaneClick}
                onRemoveNode={removeNode}
                onUpdateNodeLabel={updateNodeLabel}
            />

            <AgentSourcePickerDialog
                open={sourcePickerOpen}
                onOpenChange={setSourcePickerOpen}
                onCreateNew={onOpenCreateConfig}
            />

            <CreateAgentConfigDialog
                projectId={projectId}
                environmentId={environmentId}
                open={configDialogOpen}
                onOpenChange={setConfigDialogOpen}
            />

            <ToolSourcePickerDialog
                open={toolPickerOpen}
                onOpenChange={setToolPickerOpen}
                onSelect={onToolSelect}
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
