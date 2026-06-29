"use client";

/**
 * Slide-in detail for one sandbox instance. The Detail tab shows the instance's
 * runtime identity + size and hosts the snapshot + terminate actions; the Terminal
 * tab is reserved for the live PTY (pending the core PTY WebSocket proxy).
 */

import { DeleteConfirmDialog } from "@/app/components/DeleteConfirmDialog";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/app/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/app/components/ui/tabs";
import { api } from "@broods/convex/_generated/api";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useAction } from "convex/react";
import { Camera } from "lucide-react";
import { useState } from "react";
import { formatSpecs, instanceStatusBadge, relativeTime } from "./sandboxFormat";

interface Props {
    /** The instance whose detail is shown. */
    instance: Doc<"sandboxInstances">;
    /** Close the sheet. */
    onClose: () => void;
}

/** One label/value detail row. */
function Field({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-start justify-between gap-4 border-b border-border py-2 last:border-0">
            <span className="text-xs text-muted-foreground">{label}</span>
            <span className="text-right text-xs text-foreground">{value}</span>
        </div>
    );
}

export function SandboxInstanceSheet({ instance, onClose }: Props) {
    const createSnapshot = useAction(api.sandboxPublic.createSnapshot);
    const terminate = useAction(api.sandboxPublic.terminateSandbox);

    const [snapName, setSnapName] = useState("");
    const [snapPending, setSnapPending] = useState(false);
    const [snapMessage, setSnapMessage] = useState<string | null>(null);
    const [terminating, setTerminating] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);

    const controllable = Boolean(instance.sandboxConfigId);
    // Only the self-hosted workdir `sandbox` provider can capture a running instance
    // into a reusable image. AWS MicroVM (`lambda`) and the third-party providers have
    // no runtime snapshot-to-image API, so the capture action is hidden for them —
    // their state is still preserved across idle via suspend/resume.
    const supportsSnapshot = instance.provider === "sandbox";

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
                            {instance.snapshotId && <Field label="Snapshot" value={<code className="font-mono">{instance.snapshotId}</code>} />}
                            <Field label="Created" value={relativeTime(instance.createdAt)} />
                            <Field label="Last used" value={relativeTime(instance.lastUsedAt)} />
                            {instance.suspendedAt && <Field label="Suspended" value={relativeTime(instance.suspendedAt)} />}
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
                        <div className="rounded-lg border border-border bg-card px-4 py-10 text-center">
                            <p className="text-sm text-foreground">Live terminal coming soon.</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                The interactive PTY streams through broods&apos;s terminal proxy, which is
                                provisioned alongside the self-hosted data plane.
                            </p>
                        </div>
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
