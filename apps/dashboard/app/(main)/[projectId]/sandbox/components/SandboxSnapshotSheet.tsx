"use client";

/**
 * Slide-in detail for one sandbox snapshot/image. Read-only: snapshots are
 * captured from a running instance (see the instance detail sheet) or published
 * by the image pipeline, so this view exposes their identity and build state.
 */

import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from "@/app/components/ui/sheet";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { relativeTime, snapshotStatusBadge } from "./sandboxFormat";

interface Props {
    /** The snapshot whose detail is shown. */
    snapshot: Doc<"sandboxSnapshots">;
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

export function SandboxSnapshotSheet({ snapshot, onClose }: Props) {
    return (
        <Sheet open onOpenChange={(open) => !open && onClose()}>
            <SheetContent className="w-full overflow-y-auto sm:max-w-md">
                <SheetHeader>
                    <SheetTitle className="flex items-center gap-2">
                        {snapshot.name}
                        {snapshotStatusBadge(snapshot.status)}
                    </SheetTitle>
                    <SheetDescription>{snapshot.provider} snapshot / image</SheetDescription>
                </SheetHeader>

                <div className="px-4 pb-4">
                    <div className="rounded-lg border border-border bg-card px-4">
                        <Field label="Provider" value={snapshot.provider} />
                        <Field label="Status" value={snapshot.status} />
                        <Field label="Base image" value={snapshot.baseImage} />
                        <Field label="Image ID" value={<code className="font-mono break-all">{snapshot.externalImageId}</code>} />
                        <Field label="Pulled" value={snapshot.pulledCount} />
                        <Field label="Created" value={relativeTime(snapshot.createdAt)} />
                        <Field label="Last used" value={relativeTime(snapshot.lastUsedAt)} />
                    </div>

                    <p className="mt-4 text-xs text-muted-foreground">
                        Launch a sandbox from this image by pinning its name on a sandbox config.
                    </p>
                </div>
            </SheetContent>
        </Sheet>
    );
}
