"use client";

/**
 * Renders the active org's sandbox snapshots/images with their unified build
 * status. Snapshots are captured from instances (see the instance detail sheet) or
 * registered by the image pipeline; this view is read-only. Clicking a row opens
 * the snapshot detail sheet.
 */

import type { Doc } from "@broods/convex/_generated/dataModel";
import { useState } from "react";
import { SandboxSnapshotSheet } from "./SandboxSnapshotSheet";
import { relativeTime, snapshotStatusBadge } from "./sandboxFormat";

interface Props {
    /** Snapshot rows from Convex. */
    snapshots: Array<Doc<"sandboxSnapshots">>;
}

export function SandboxSnapshotsTable({ snapshots }: Props) {
    const [selected, setSelected] = useState<Doc<"sandboxSnapshots"> | null>(null);

    if (snapshots.length === 0) {
        return (
            <div className="rounded-lg border border-border bg-card px-4 py-10 text-center">
                <p className="text-sm text-foreground">No snapshots yet.</p>
                <p className="mt-1 text-xs text-muted-foreground">
                    Capture one from a running instance&apos;s detail panel, or publish a curated image.
                </p>
            </div>
        );
    }

    return (
        <>
            <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                            <th className="px-4 py-2 text-left font-medium">Name</th>
                            <th className="px-4 py-2 text-left font-medium">Provider</th>
                            <th className="px-4 py-2 text-left font-medium">Status</th>
                            <th className="px-4 py-2 text-left font-medium">Base image</th>
                            <th className="px-4 py-2 text-right font-medium">Pulled</th>
                            <th className="px-4 py-2 text-left font-medium">Created</th>
                            <th className="px-4 py-2 text-left font-medium">Last used</th>
                        </tr>
                    </thead>
                    <tbody>
                        {snapshots.map((snapshot) => (
                            <tr
                                key={snapshot._id}
                                className="cursor-pointer border-t border-border hover:bg-muted/30"
                                onClick={() => setSelected(snapshot)}
                            >
                                <td className="px-4 py-2.5">
                                    <div className="font-medium text-foreground">{snapshot.name}</div>
                                    <div className="font-mono text-xs text-muted-foreground">{snapshot.externalImageId}</div>
                                </td>
                                <td className="px-4 py-2.5 text-xs">{snapshot.provider}</td>
                                <td className="px-4 py-2.5">{snapshotStatusBadge(snapshot.status)}</td>
                                <td className="px-4 py-2.5 text-xs text-muted-foreground">{snapshot.baseImage}</td>
                                <td className="px-4 py-2.5 text-right text-xs text-muted-foreground">{snapshot.pulledCount}</td>
                                <td className="px-4 py-2.5 text-xs text-muted-foreground">{relativeTime(snapshot.createdAt)}</td>
                                <td className="px-4 py-2.5 text-xs text-muted-foreground">{relativeTime(snapshot.lastUsedAt)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {selected && (
                <SandboxSnapshotSheet
                    snapshot={selected}
                    onClose={() => setSelected(null)}
                />
            )}
        </>
    );
}
