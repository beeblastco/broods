"use client";

/** Monitoring panel: direct CloudWatch Logs query + error management. */
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { Section } from "@/app/components/Section";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { AlertCircle, ExternalLink, RefreshCw, Server } from "lucide-react";
import { useEffect, useState } from "react";
import { toErrorMessage } from "@/app/lib/errors";

interface Props {
    projectId: Id<"projects">;
}

const LEVEL_COLORS: Record<string, string> = {
    ERROR: "text-red-500",
    WARN: "text-amber-500",
    INFO: "text-blue-400",
    DEBUG: "text-muted-foreground",
};

const LEVEL_BADGE: Record<string, "destructive" | "warning" | "secondary"> = {
    ERROR: "destructive",
    WARN: "warning",
    INFO: "secondary",
    DEBUG: "secondary",
};

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function MonitoringPanel({ projectId }: Props) {
    const [isFetching, setIsFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [logEntries, setLogEntries] = useState<Awaited<ReturnType<typeof api.logs.fetchForProject>> | null>(null);

    const fetchForProject = useAction(api.logs.fetchForProject);

    async function handleRefresh() {
        setIsFetching(true);
        setFetchError(null);
        try {
            const logs = await fetchForProject({ projectId: projectId });
            setLogEntries(logs);
        } catch (err) {
            setFetchError(toErrorMessage(err));
        } finally {
            setIsFetching(false);
        }
    }

    useEffect(() => {
        handleRefresh();
    }, []);

    const errorCount = logEntries?.filter((e) => e.level === "ERROR").length ?? 0;
    const warnCount = logEntries?.filter((e) => e.level === "WARN").length ?? 0;

    return (
        <div className="grid gap-8">
            <Section title="System Overview" description="Error and warning counts from CloudWatch Logs.">
                <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-lg border border-border bg-card px-4 py-3">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="size-4 text-red-500" />
                            <span className="text-xs text-muted-foreground">Errors</span>
                        </div>
                        <p className="mt-2 text-2xl font-semibold text-foreground">{errorCount}</p>
                    </div>
                    <div className="rounded-lg border border-border bg-card px-4 py-3">
                        <div className="flex items-center gap-2">
                            <AlertCircle className="size-4 text-amber-500" />
                            <span className="text-xs text-muted-foreground">Warnings</span>
                        </div>
                        <p className="mt-2 text-2xl font-semibold text-foreground">{warnCount}</p>
                    </div>
                </div>
            </Section>

            <Section
                title="CloudWatch Logs"
                description="Live log stream queried directly from AWS CloudWatch."
            >
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Server className="size-4 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                            {logEntries?.length ?? 0} entries
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            size="sm"
                            variant="outline"
                            className="cursor-pointer gap-1.5"
                            onClick={handleRefresh}
                            disabled={isFetching}
                        >
                            <RefreshCw className={`size-3.5 ${isFetching ? "animate-spin" : ""}`} />
                            {isFetching ? "Fetching…" : "Refresh Logs"}
                        </Button>
                    </div>
                </div>

                {fetchError && (
                    <p className="mb-3 text-sm text-destructive">{fetchError}</p>
                )}

                {logEntries === null && !isFetching && (
                    <div className="rounded-lg border border-border bg-card px-4 py-6 text-center">
                        <p className="text-sm text-muted-foreground">No logs loaded yet.</p>
                        <p className="text-xs text-muted-foreground mt-1">
                            Click &ldquo;Refresh Logs&rdquo; to query CloudWatch.
                        </p>
                    </div>
                )}

                {logEntries !== null && logEntries.length === 0 && (
                    <div className="rounded-lg border border-border bg-card px-4 py-8 text-center">
                        <Server className="size-8 mx-auto mb-2 text-muted-foreground" />
                        <p className="text-sm text-muted-foreground">No logs found in CloudWatch.</p>
                        <p className="text-xs text-muted-foreground mt-1">
                            Logs may not exist yet for these deployments.
                        </p>
                    </div>
                )}

                {logEntries !== null && logEntries.length > 0 && (
                    <div className="rounded-lg border border-border bg-card divide-y divide-border font-mono text-xs overflow-hidden">
                        {logEntries.map((entry, i) => (
                            <div key={i} className="flex items-start gap-3 px-4 py-2.5">
                                <span className="shrink-0 text-muted-foreground tabular-nums">
                                    {formatTime(entry.timestamp)}
                                </span>
                                <Badge
                                    variant={LEVEL_BADGE[entry.level] ?? "secondary"}
                                    className="shrink-0 text-[10px] px-1.5"
                                >
                                    {entry.level}
                                </Badge>
                                <span className="shrink-0 text-muted-foreground/60">
                                    {entry.functionName}
                                </span>
                                <span className={`flex-1 break-all ${LEVEL_COLORS[entry.level] ?? ""}`}>
                                    {entry.message}
                                </span>
                            </div>
                        ))}
                    </div>
                )}
            </Section>
        </div>
    );
}
