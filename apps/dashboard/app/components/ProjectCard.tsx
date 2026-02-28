"use client";

/** Project card with a flush canvas preview on top and project info on the bottom. */
import { useGatewayHealth } from "@/app/hooks/useAgentHealth";
import dynamic from "next/dynamic";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/app/components/ui/card";
import { Bot } from "lucide-react";
import { memo, useCallback } from "react";
import { useRouter } from "next/navigation";

// Defer loading React Flow preview code until cards render on the client.
const CanvasPreview = dynamic(
    () => import("@/app/components/CanvasPreview").then((mod) => mod.CanvasPreview),
    { loading: () => <div className="flex h-full w-full items-center justify-center"><p className="text-xs text-muted-foreground/40">Loading preview...</p></div> },
);

type CanvasData = {
    nodes: Array<{
        id: string;
        type: "agent" | "database" | "workspace" | "tool";
        position: { x: number; y: number };
        data: { label: string; status?: "running" | "idle" | "error" };
    }>;
    edges: Array<{ id: string; source: string; target: string }>;
} | null;

type ProjectStatus = "healthy" | "unhealthy" | "deploying" | "idle" | "empty";

const STATUS_CONFIG: Record<ProjectStatus, { label: string; color: string }> = {
    healthy: { label: "Healthy", color: "bg-emerald-500" },
    unhealthy: { label: "Unhealthy", color: "bg-red-500" },
    deploying: { label: "Deploying", color: "bg-amber-500" },
    idle: { label: "Idle", color: "bg-zinc-500" },
    empty: { label: "No agents", color: "bg-zinc-700" },
};

/** Derives the overall project status from deployment count and gateway health. */
function getProjectStatus(agentCount: number, deployedAgentCount: number, gatewayHealthy: boolean | null): ProjectStatus {
    if (agentCount === 0) return "empty";
    if (deployedAgentCount === 0) return "idle";
    if (gatewayHealthy === null) return "deploying";

    return gatewayHealthy ? "healthy" : "unhealthy";
}

interface ProjectCardProps {
    name: string;
    canvas: CanvasData;
    projectId: string;
    deployedAgentCount: number;
}

/** Preload the Canvas module so it's cached before the user navigates. */
const preloadCanvas = () => import("@/app/components/canvas/Canvas");

/** Renders a project card with a canvas preview on top flush to the border, and project info below on the card background. */
export const ProjectCard = memo(function ProjectCard({ name, canvas, projectId, deployedAgentCount }: ProjectCardProps) {
    const router = useRouter();
    const gatewayHealthy = useGatewayHealth();
    const agentCount = canvas?.nodes.filter((n) => n.type === "agent").length ?? 0;
    const status = getProjectStatus(agentCount, deployedAgentCount, gatewayHealthy);
    const { label, color } = STATUS_CONFIG[status];
    const nodeCount = canvas?.nodes.length ?? 0;
    const handleClick = useCallback(() => router.push(`/${projectId}`), [router, projectId]);

    return (
        <Card
            className="cursor-pointer gap-0 overflow-hidden p-0 transition-all hover:ring-2 hover:ring-primary/50"
            onClick={handleClick}
            onMouseEnter={preloadCanvas}
        >
            {/* Canvas preview — no padding, flush to card top and sides */}
            <div className="aspect-5/3 w-full">
                <CanvasPreview canvas={canvas} />
            </div>

            {/* Project info — normal card background */}
            <CardHeader className="border-t border-border px-4 py-3">
                <CardTitle className="truncate text-sm font-medium">{name}</CardTitle>

                <CardDescription className="flex items-center gap-2.5">
                    {nodeCount > 0 && (
                        <span className="flex items-center gap-1">
                            <Bot className="size-3" />
                            {agentCount} agent{agentCount !== 1 ? "s" : ""}
                        </span>
                    )}

                    <span className="flex items-center gap-1.5">
                        <span className={`inline-block size-1.5 rounded-full ${color}`} />
                        {label}
                    </span>
                </CardDescription>
            </CardHeader>
        </Card>
    );
});
