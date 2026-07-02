"use client";

/**
 * Slide-in detail for one sandbox instance. The Detail tab shows the instance's
 * runtime identity + size and hosts the snapshot + terminate actions; the Terminal
 * tab is a live in-guest PTY for workdir instances and a bounded command runner
 * for providers without a PTY endpoint.
 */

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Textarea } from "@/app/components/ui/textarea";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/app/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { api } from "@broods/convex/_generated/api";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { Camera, ExternalLink, Play, RefreshCw, Terminal } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { LiveSandboxTerminal } from "./LiveSandboxTerminal";
import { formatSpecs, instanceStatusBadge, relativeTime } from "./sandboxFormat";

interface Props {
    /** The instance whose detail is shown. */
    instance: Doc<"sandboxInstances">;
    /** Current project route id, used to build trace deep links. */
    projectId: Id<"projects">;
    /** Close the sheet. */
    onClose: () => void;
}

type TerminalResult = {
    ok: boolean;
    runtime: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    truncated: boolean;
    provider: string;
};

type TerminalEntry = {
    command: string;
    result?: TerminalResult;
    error?: string;
};

/** One label/value detail row. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4 border-b border-border py-2 last:border-0">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-right text-xs text-foreground">{value}</span>
        </div>
    );
}

/** Inline link button that deep-links to a trace in the dashboard. */
function TraceLink({ traceId, href }: { traceId: string; href: string }) {
    return (
        <Button asChild variant="outline" size="xs" className="cursor-pointer">
            <Link href={href}>
                <code className="max-w-45 truncate font-mono">{traceId}</code>
                <ExternalLink className="size-3" />
            </Link>
        </Button>
    );
}

export function SandboxInstanceSheet({ instance, projectId, onClose }: Props) {
    const createSnapshot = useAction(api.sandboxPublic.createSnapshot);
    const refresh = useAction(api.sandboxPublic.refreshSandbox);
    const runCommand = useAction(api.sandboxPublic.runSandboxCommand);
    const terminate = useAction(api.sandboxPublic.terminateSandbox);
    const searchParams = useSearchParams();

    const [snapName, setSnapName] = useState("");
    const [snapPending, setSnapPending] = useState(false);
    const [snapMessage, setSnapMessage] = useState<string | null>(null);
    const [terminating, setTerminating] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [command, setCommand] = useState("pwd && ls -la");
    const [commandPending, setCommandPending] = useState(false);
    const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);

    const controllable = Boolean(instance.sandboxConfigId);
    const commandRunnable = controllable && instance.status !== "terminating";
    // The self-hosted workdir `sandbox` provider exposes an in-guest PTY WebSocket
    // and AWS MicroVM (`lambda`) exposes its native shell endpoint; the third-party
    // providers keep the bounded command runner.
    const supportsLiveTerminal = instance.provider === "sandbox" || instance.provider === "lambda";
    // Only the self-hosted workdir `sandbox` provider can capture a running instance
    // into a reusable image. AWS MicroVM (`lambda`) and the third-party providers have
    // no runtime snapshot-to-image API, so the capture action is hidden for them —
    // their state is still preserved across idle via suspend/resume.
    const supportsSnapshot = instance.provider === "sandbox";

    function traceHref(traceId: string): string {
        const next = new URLSearchParams();
        const env = searchParams.get("env");
        if (env) next.set("env", env);
        next.set("tab", "tracing");
        next.set("trace", traceId);

        return `/${projectId}/dashboard?${next.toString()}`;
    }

    async function handleSnapshot() {
        if (!instance.sandboxConfigId || !snapName.trim()) return;
        setSnapPending(true);
        setSnapMessage(null);
        try {
            await createSnapshot({
                sandboxId: instance.sandboxConfigId,
                reservationKey: instance.reservationKey,
                name: snapName.trim(),
            });
            setSnapName("");
            setSnapMessage("Snapshot captured.");
        } catch (err) {
            setSnapMessage(err instanceof Error ? err.message : "Snapshot failed");
        } finally {
            setSnapPending(false);
        }
    }

    async function handleTerminate() {
        if (!instance.sandboxConfigId) return;
        setTerminating(true);
        try {
            await terminate({ sandboxId: instance.sandboxConfigId, reservationKey: instance.reservationKey });
            setConfirmOpen(false);
            onClose();
        } finally {
            setTerminating(false);
        }
    }

    async function handleRefresh() {
        if (!instance.sandboxConfigId) return;
        setRefreshing(true);
        setRefreshMessage(null);
        try {
            await refresh({ sandboxId: instance.sandboxConfigId, reservationKey: instance.reservationKey });
            setRefreshMessage("Status refreshed.");
        } catch (err) {
            setRefreshMessage(err instanceof Error ? err.message : "Refresh failed");
        } finally {
            setRefreshing(false);
        }
    }

    async function handleCommand() {
        if (!instance.sandboxConfigId || !command.trim()) return;
        const code = command.trim();
        setCommandPending(true);
        try {
            const result = await runCommand({
                sandboxId: instance.sandboxConfigId,
                reservationKey: instance.reservationKey,
                code: code,
            });
            setTerminalEntries((entries) => [{ command: code, result: result }, ...entries].slice(0, 20));
        } catch (err) {
            setTerminalEntries((entries) => [{
                command: code,
                error: err instanceof Error ? err.message : "Command failed",
            }, ...entries].slice(0, 20));
        } finally {
            setCommandPending(false);
        }
    }

    return (
        <Sheet open onOpenChange={(open) => !open && onClose()}>
            <SheetContent className="w-full overflow-y-auto sm:max-w-md">
                <SheetHeader>
                    <SheetTitle className="flex items-center gap-2">
                        {instance.name}
                        {instanceStatusBadge(instance.status)}
                    </SheetTitle>
                    <SheetDescription>{instance.provider} sandbox instance</SheetDescription>
                </SheetHeader>

                <Tabs defaultValue="detail" className="px-4 pb-4">
                    <TabsList>
                        <TabsTrigger value="detail">Detail</TabsTrigger>
                        <TabsTrigger value="terminal">Terminal</TabsTrigger>
                    </TabsList>

                    <TabsContent value="detail" className="mt-4">
                        <div className="rounded-lg border border-border bg-card px-4">
                            <Field label="Provider" value={instance.provider} />
                            <Field label="Status" value={instance.status} />
                            <Field label="Size" value={formatSpecs(instance.specs)} />
                            <Field label="External ID" value={<code className="font-mono">{instance.externalId}</code>} />
                            <Field label="Reservation key" value={<code className="font-mono break-all">{instance.reservationKey}</code>} />
                            {instance.agentId && <Field label="Agent" value={<code className="font-mono">{instance.agentId}</code>} />}
                            {instance.conversationKey && <Field label="Conversation" value={<code className="font-mono break-all">{instance.conversationKey}</code>} />}
                            {instance.workspaceName && <Field label="Workspace" value={instance.workspaceName} />}
                            {instance.createdByTraceId && <Field label="Created trace" value={<TraceLink traceId={instance.createdByTraceId} href={traceHref(instance.createdByTraceId)} />} />}
                            {instance.lastUsedTraceId && <Field label="Last trace" value={<TraceLink traceId={instance.lastUsedTraceId} href={traceHref(instance.lastUsedTraceId)} />} />}
                            {instance.snapshotId && <Field label="Snapshot" value={<code className="font-mono">{instance.snapshotId}</code>} />}
                            <Field label="Created" value={relativeTime(instance.createdAt)} />
                            <Field label="Last used" value={relativeTime(instance.lastUsedAt)} />
                            {instance.suspendedAt && <Field label="Suspended" value={relativeTime(instance.suspendedAt)} />}
                        </div>

                        <div className="mt-4">
                            <Button
                                variant="outline"
                                size="sm"
                                className="cursor-pointer disabled:cursor-not-allowed"
                                disabled={!controllable || refreshing}
                                onClick={handleRefresh}
                            >
                                <RefreshCw className="mr-1 size-3.5" />
                                Refresh status
                            </Button>
                            {refreshMessage && <p className="mt-2 text-xs text-muted-foreground">{refreshMessage}</p>}
                        </div>

                        <div className="mt-5">
                            <h4 className="text-sm font-medium text-foreground">Snapshot</h4>
                            {supportsSnapshot ? (
                                <>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                        Capture the current sandbox state as a reusable image.
                                    </p>
                                    <div className="mt-2 flex items-center gap-2">
                                        <Input
                                            value={snapName}
                                            onChange={(e) => setSnapName(e.target.value)}
                                            placeholder="snapshot name"
                                            disabled={!controllable || snapPending}
                                            className="h-8"
                                        />
                                        <Button
                                            size="sm"
                                            className="cursor-pointer disabled:cursor-not-allowed"
                                            disabled={!controllable || snapPending || !snapName.trim()}
                                            onClick={handleSnapshot}
                                        >
                                            <Camera className="mr-1 size-3.5" />
                                            Snapshot
                                        </Button>
                                    </div>
                                    {snapMessage && <p className="mt-2 text-xs text-muted-foreground">{snapMessage}</p>}
                                </>
                            ) : (
                                <p className="mt-1 text-xs text-muted-foreground">
                                    {instance.provider} sandboxes have no runtime image-capture API, so snapshots
                                    aren&apos;t created here. State is preserved across idle via suspend/resume, and
                                    the launch image is managed as versioned {instance.provider} image builds.
                                </p>
                            )}
                        </div>

                        <div className="mt-6 rounded-lg border border-destructive/30 bg-destructive/5 p-4">
                            <h4 className="text-sm font-medium text-destructive">Danger zone</h4>
                            <p className="mt-1 text-xs text-muted-foreground">
                                Terminate the instance, releasing its reservation and compute.
                            </p>
                            <Button
                                variant="destructive"
                                size="sm"
                                className="mt-3 cursor-pointer disabled:cursor-not-allowed"
                                disabled={!controllable}
                                onClick={() => setConfirmOpen(true)}
                            >
                                Terminate
                            </Button>
                        </div>

                        {!controllable && (
                            <p className="mt-3 text-xs text-muted-foreground">
                                This instance predates the config link, so it can be viewed but not controlled here.
                            </p>
                        )}
                    </TabsContent>

                    <TabsContent value="terminal" className="mt-4">
                        {supportsLiveTerminal && instance.sandboxConfigId ? (
                            <LiveSandboxTerminal
                                sandboxId={instance.sandboxConfigId}
                                reservationKey={instance.reservationKey}
                                disabled={!commandRunnable}
                            />
                        ) : (
                        <div className="space-y-3">
                            <div className="rounded-lg border border-border bg-card p-3">
                                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-foreground">
                                    <Terminal className="size-4" />
                                    Shell command
                                </div>
                                <Textarea
                                    value={command}
                                    onChange={(event) => setCommand(event.target.value)}
                                    disabled={!commandRunnable || commandPending}
                                    rows={4}
                                    className="cursor-text font-mono text-xs disabled:cursor-not-allowed"
                                />
                                <div className="mt-2 flex items-center justify-between gap-3">
                                    <p className="text-xs text-muted-foreground">
                                        Runs in the reserved sandbox with a 30s timeout and 64 KiB output cap.
                                    </p>
                                    <Button
                                        type="button"
                                        size="sm"
                                        disabled={!commandRunnable || commandPending || !command.trim()}
                                        onClick={handleCommand}
                                        className="cursor-pointer disabled:cursor-not-allowed"
                                    >
                                        <Play className="mr-1 size-3.5" />
                                        Run
                                    </Button>
                                </div>
                                {!commandRunnable && (
                                    <p className="mt-2 text-xs text-muted-foreground">
                                        This instance cannot run commands from the dashboard in its current state.
                                    </p>
                                )}
                            </div>

                            <div className="space-y-2">
                                {terminalEntries.length === 0 ? (
                                    <div className="rounded-lg border border-border bg-muted/30 px-3 py-8 text-center text-xs text-muted-foreground">
                                        Run a command to see stdout, stderr, and exit status here.
                                    </div>
                                ) : terminalEntries.map((entry, index) => (
                                    <div key={`${entry.command}-${index}`} className="rounded-lg border border-border bg-black p-3 text-xs text-white">
                                        <div className="mb-2 flex items-center justify-between gap-3 text-[11px] text-zinc-400">
                                            <code className="min-w-0 flex-1 truncate">$ {entry.command}</code>
                                            {entry.result && (
                                                <span className={entry.result.ok ? "shrink-0 text-emerald-300" : "shrink-0 text-red-300"}>
                                                    exit {entry.result.exitCode ?? "?"} · {entry.result.durationMs}ms
                                                </span>
                                            )}
                                        </div>
                                        {entry.error ? (
                                            <pre className="whitespace-pre-wrap break-words text-red-200">{entry.error}</pre>
                                        ) : (
                                            <>
                                                {entry.result?.stdout && <pre className="whitespace-pre-wrap break-words text-zinc-100">{entry.result.stdout}</pre>}
                                                {entry.result?.stderr && <pre className="mt-2 whitespace-pre-wrap break-words text-amber-200">{entry.result.stderr}</pre>}
                                                {entry.result?.truncated && <p className="mt-2 text-[11px] text-amber-200">Output truncated.</p>}
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                        )}
                    </TabsContent>
                </Tabs>
            </SheetContent>

            <DeleteConfirmDialog
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                resourceName={instance.name}
                resourceType="sandbox instance"
                critical={false}
                onConfirm={handleTerminate}
                isDeleting={terminating}
            />
        </Sheet>
    );
}
