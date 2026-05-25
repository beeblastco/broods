"use client";

/** Monitoring panel: direct CloudWatch Logs query showing ERROR-level events only. */
import { Section } from "@/app/components/Section";
import { Badge } from "@/app/components/ui/badge";
import { Button } from "@/app/components/ui/button";
import { toErrorMessage } from "@/app/lib/errors";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface Props {
    projectId: Id<"projects">;
}

function formatTime(ms: number): string {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function MonitoringPanel({ projectId }: Props) {
    const [isFetching, setIsFetching] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [logEntries, setLogEntries] = useState<FunctionReturnType<typeof api.logs.fetchForProject> | null>(null);

    const fetchForProject = useAction(api.logs.fetchForProject);

    const handleRefresh = useCallback(async () => {
        setIsFetching(true);
        setFetchError(null);
        try {
            const logs = await fetchForProject({ projectId: projectId, errorOnly: true });
            setLogEntries(logs);
        } catch (err) {
            setFetchError(toErrorMessage(err));
        } finally {
            setIsFetching(false);
        }
    }, [fetchForProject, projectId]);

    useEffect(() => {
        handleRefresh();
    }, [handleRefresh]);

    return (
        <div className="grid gap-8">
            <Section
                title="Error Logs"
                description="Live ERROR-level log stream queried directly from AWS CloudWatch."
            >
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <Server className="size-4 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground">
                            {logEntries?.length ?? 0} errors
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
                        <p className="text-sm text-muted-foreground">No errors found.</p>
                        <p className="text-xs text-muted-foreground mt-1">
                            All deployments are running cleanly in the selected window.
                        </p>
                    </div>
                )}

                {logEntries !== null && logEntries.length > 0 && (
                    <div className="rounded-lg border border-border bg-card divide-y divide-border font-mono text-xs max-h-[600px] overflow-y-auto">
                        {logEntries.map((entry, i) => (
                            <div key={i} className="flex flex-col gap-1.5 px-4 py-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="shrink-0 text-muted-foreground tabular-nums">
                                        {formatTime(entry.timestamp)}
                                    </span>
                                    <Badge variant="destructive" className="shrink-0 text-[10px] px-1.5">
                                        {entry.level}
                                    </Badge>
                                    <span className="truncate text-muted-foreground/60" title={entry.functionName}>
                                        {entry.functionName}
                                    </span>
                                </div>
                                <pre className="whitespace-pre-wrap break-words text-red-400 leading-relaxed">
                                    {entry.message}
                                </pre>
                            </div>
                        ))}
                    </div>
                )}
            </Section>
        </div>
    );
}
