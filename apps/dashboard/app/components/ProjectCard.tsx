"use client";

/** Project card with a flush canvas preview on top and project info on the bottom. */
import { CanvasPreview } from "@/app/components/CanvasPreview";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/app/components/ui/card";
import { Bot } from "lucide-react";

type CanvasData = {
    nodes: Array<{
        id: string;
        type: "agent" | "database" | "workspace" | "tool";
        position: { x: number; y: number };
        data: { label: string; status?: "running" | "idle" | "error" };
    }>;
    edges: Array<{ id: string; source: string; target: string }>;
} | null;

type ProjectStatus = "running" | "error" | "idle" | "empty";

const STATUS_CONFIG: Record<ProjectStatus, { label: string; color: string }> = {
    running: { label: "Running", color: "bg-emerald-500" },
    error: { label: "Error", color: "bg-red-500" },
    idle: { label: "Idle", color: "bg-zinc-500" },
    empty: { label: "No agents", color: "bg-zinc-700" },
};

/** Derives the overall status of a project from its canvas node statuses. */
function getProjectStatus(canvas: CanvasData): ProjectStatus {
    if (!canvas || canvas.nodes.length === 0) return "empty";

    const hasRunning = canvas.nodes.some((n) => n.data.status === "running");
    const hasError = canvas.nodes.some((n) => n.data.status === "error");

    if (hasRunning) return "running";
    if (hasError) return "error";

    return "idle";
}

interface ProjectCardProps {
    name: string;
    canvas: CanvasData;
    onClick: () => void;
}

/** Renders a project card with a canvas preview on top flush to the border, and project info below on the card background. */
export function ProjectCard({ name, canvas, onClick }: ProjectCardProps) {
    const status = getProjectStatus(canvas);
    const { label, color } = STATUS_CONFIG[status];
    const agentCount =
        canvas?.nodes.filter((n) => n.type === "agent").length ?? 0;
    const nodeCount = canvas?.nodes.length ?? 0;

    return (
        <Card
            className="cursor-pointer gap-0 overflow-hidden p-0 transition-all hover:ring-2 hover:ring-primary/50"
            onClick={onClick}
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
}
