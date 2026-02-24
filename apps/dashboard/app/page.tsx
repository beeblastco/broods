"use client";

import {
    addEdge,
    Background,
    Panel,
    ReactFlow,
    useEdgesState,
    useNodesState,
    useReactFlow,
    type Edge,
    type Node,
    type OnConnect,
} from "@xyflow/react";
import { useCallback } from "react";
import { Header } from "./components/Header";
import { AgentNode } from "./components/node/Agent";

const nodeTypes = { agent: AgentNode };

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

function CanvasControls() {
    const { zoomIn, zoomOut, fitView } = useReactFlow();
    const btn =
        "flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/[0.04] hover:text-white/60";

    return (
        <div className="flex flex-col rounded-lg border border-white/6 bg-[#141414]/80 p-0.5 backdrop-blur-md" >
            <button onClick={() => zoomIn()} className={btn} >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" >
                    <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                </svg>
            </button>
            < button onClick={() => zoomOut()
            } className={btn} >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" >
                    <path d="M2.5 7h9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                </svg>
            </button>
            < div className="mx-1.5 my-0.5 border-t border-white/6" />
            <button onClick={() => fitView()} className={btn} >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" >
                    <path d="M1.5 5V2.5a1 1 0 011-1H5M9 1.5h2.5a1 1 0 011 1V5M12.5 9v2.5a1 1 0 01-1 1H9M5 12.5H2.5a1 1 0 01-1-1V9" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </button>
        </div>
    );
}

export default function Home() {
    const [nodes, , onNodesChange] = useNodesState(initialNodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

    const onConnect: OnConnect = useCallback(
        (params) => setEdges((eds) => addEdge(params, eds)),
        [setEdges],
    );

    return (
        <div className="flex h-screen w-screen flex-col bg-[#0a0a0a]" >
            <Header />

            < div className="flex-1" >
                <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={onConnect}
                    nodeTypes={nodeTypes}
                    fitView
                    colorMode="dark"
                    proOptions={{ hideAttribution: true }
                    }
                    defaultEdgeOptions={{
                        style: { stroke: "rgba(255,255,255,0.15)", strokeWidth: 1.5 },
                        animated: true,
                    }}
                >
                    <Background gap={24} size={1.5} color="rgba(255,255,255,0.08)" />
                    <Panel position="top-left" >
                        <CanvasControls />
                    </Panel>
                </ReactFlow>
            </div>
        </div>
    );
}
