"use client";

/** Tool test tab for executing the saved tool source code with custom JSON input. */
import { Button } from "@/app/components/ui/button";
import { Textarea } from "@/app/components/ui/textarea";
import { api } from "@filthy-panty/convex/_generated/api";
import type { Id } from "@filthy-panty/convex/_generated/dataModel";
import { toErrorMessage } from "@/app/lib/errors";
import { useAction, useQuery } from "convex/react";
import { Loader2, Play } from "lucide-react";
import { useEffect, useState } from "react";

/** Safe JSON pretty-printer for execution output and errors. */
function formatValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return String(value);
    }
}

/** Human-readable duration formatter for execution timing. */
function formatDuration(ms: number): string {
    if (ms < 1_000) {
        return `${Math.round(ms)} ms`;
    }

    if (ms < 60_000) {
        const seconds = ms / 1_000;

        return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
    }

    const minutes = Math.floor(ms / 60_000);
    const seconds = (ms % 60_000) / 1_000;

    return `${minutes}m ${seconds.toFixed(1)}s`;
}

export function ToolTestTab({
    projectId,
    environmentId,
    nodeId,
}: {
    projectId: Id<"projects"> | undefined;
    environmentId: Id<"environments"> | null;
    nodeId: string;
}) {
    const canQueryTool = !!projectId && !!environmentId;
    const executeTool = useAction(api.toolService.execute);
    const toolService = useQuery(
        api.toolService.getByNode,
        canQueryTool
            ? {
                projectId: projectId,
                environmentId: environmentId,
                nodeId: nodeId,
            }
            : "skip",
    );

    const [inputJson, setInputJson] = useState("{\n  \"hello\": \"world\"\n}");
    const [isRunning, setIsRunning] = useState(false);
    const [runError, setRunError] = useState<string | null>(null);
    const [runOutput, setRunOutput] = useState<string | null>(null);
    const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
    const [elapsedMs, setElapsedMs] = useState<number>(0);
    const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);

    useEffect(() => {
        if (!isRunning || runStartedAt === null) {
            return;
        }

        const interval = window.setInterval(() => {
            setElapsedMs(performance.now() - runStartedAt);
        }, 100);

        return () => {
            window.clearInterval(interval);
        };
    }, [isRunning, runStartedAt]);

    async function handleRun() {
        setRunError(null);
        setRunOutput(null);

        let parsedInput: unknown;
        try {
            parsedInput = JSON.parse(inputJson);
        } catch {
            setRunError("Input must be valid JSON.");

            return;
        }

        if (!projectId || !environmentId) {
            setRunError("Project and environment context are required to run this tool.");

            return;
        }

        if (!toolService) {
            setRunError("Tool configuration is missing. Save it from the Config tab first.");

            return;
        }
        if (toolService.status !== "enabled") {
            setRunError("Tool is disabled. Enable it in Config before running.");

            return;
        }

        const startedAt = performance.now();
        setRunStartedAt(startedAt);
        setElapsedMs(0);
        setIsRunning(true);
        try {
            const body = await executeTool({
                projectId: projectId,
                environmentId: environmentId,
                nodeId: nodeId,
                input: parsedInput,
            });

            if ((body as { success?: boolean }).success === false) {
                throw new Error(
                    typeof body.error === "string" ? body.error : "Tool execution failed.",
                );
            }

            const output = (body as { output?: unknown }).output ?? body;
            setRunOutput(formatValue(output));
        } catch (error) {
            setRunError(toErrorMessage(error));
        } finally {
            const duration = performance.now() - startedAt;
            setElapsedMs(duration);
            setLastDurationMs(duration);
            setRunStartedAt(null);
            setIsRunning(false);
        }
    }

    if (!projectId) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Cannot resolve project context for this tool.
                </p>
            </div>
        );
    }

    if (!environmentId) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Select an environment before testing this tool.
                </p>
            </div>
        );
    }

    if (toolService === undefined) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    Loading tool configuration…
                </p>
            </div>
        );
    }

    if (toolService === null) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <p className="text-center text-xs text-muted-foreground">
                    No tool configuration found. Save this tool from the Config tab first.
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            <div className="flex flex-col gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Test Input (JSON)
                </span>
                <Textarea
                    value={inputJson}
                    onChange={(e) => setInputJson(e.target.value)}
                    spellCheck={false}
                    className="min-h-24 resize-y bg-muted/50 font-mono text-xs"
                />
            </div>

            {runError && (
                <p className="text-xs text-destructive">{runError}</p>
            )}

            <div className="flex items-center gap-2">
                <Button
                    size="sm"
                    className="h-8 text-xs"
                    disabled={isRunning || toolService.status !== "enabled"}
                    onClick={handleRun}
                >
                    {isRunning ? (
                        <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                        <Play className="size-3.5" />
                    )}
                    {isRunning ? "Running…" : "Run Tool"}
                </Button>
            </div>

            <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
                <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    <span>Execution Time</span>
                    <span>{isRunning ? "Running" : "Last Run"}</span>
                </div>
                <p className="mt-1 font-mono text-sm text-foreground">
                    {isRunning
                        ? formatDuration(elapsedMs)
                        : lastDurationMs === null
                          ? "No test run yet."
                          : formatDuration(lastDurationMs)}
                </p>
            </div>

            <div className="flex flex-col gap-1.5">
                <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
                    Output
                </span>
                <pre className="max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs text-foreground whitespace-pre-wrap wrap-break-word">
                    {runOutput ?? "Run the tool to see execution output."}
                </pre>
            </div>
        </div>
    );
}
