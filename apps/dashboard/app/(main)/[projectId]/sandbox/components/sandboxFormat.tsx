/**
 * Shared formatting + status-badge helpers for the Sandbox tab (instances and
 * snapshots). Keeps the instance/snapshot tables visually consistent.
 */

import { Badge } from "@/app/components/ui/badge";
import type { Doc } from "@broods/convex/_generated/dataModel";

/** Compact "Xs/m/h/d ago" relative time; em dash when unset. */
export function relativeTime(ts: number | undefined): string {
    if (!ts) return "—";
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    return `${Math.floor(hours / 24)}d ago`;
}

/** Renders an instance's vcpu/memory/disk footprint as "1 vCPU · 2 GB · 8 GB". */
export function formatSpecs(specs: Doc<"sandboxInstances">["specs"]): string {
    const memory = specs.memoryMb >= 1024 ? `${specs.memoryMb / 1024} GB` : `${specs.memoryMb} MB`;

    return `${specs.vcpu} vCPU · ${memory} · ${specs.storageGb} GB`;
}

/** Status badge for a live instance. */
export function instanceStatusBadge(status: Doc<"sandboxInstances">["status"]) {
    if (status === "running") return <Badge variant="success" className="text-xs">running</Badge>;
    if (status === "suspended") return <Badge variant="secondary" className="text-xs">suspended</Badge>;
    if (status === "terminating") return <Badge variant="warning" className="text-xs">terminating</Badge>;

    return <Badge variant="destructive" className="text-xs">error</Badge>;
}

/** Status badge for a snapshot/image's unified build status. */
export function snapshotStatusBadge(status: Doc<"sandboxSnapshots">["status"]) {
    if (status === "active") return <Badge variant="success" className="text-xs">active</Badge>;
    if (status === "error" || status === "build_failed") return <Badge variant="destructive" className="text-xs">{status}</Badge>;
    if (status === "inactive") return <Badge variant="secondary" className="text-xs">inactive</Badge>;

    return <Badge variant="warning" className="text-xs">{status}</Badge>;
}

/** Badge for an instance's tool-approval policy; em dash when the row predates the mirror. */
export function permissionModeBadge(mode: Doc<"sandboxInstances">["permissionMode"]) {
    if (mode === "ask") return <Badge variant="success" className="text-xs">ask</Badge>;
    if (mode === "edit") return <Badge variant="warning" className="text-xs">edit</Badge>;
    if (mode === "bypass") return <Badge variant="destructive" className="text-xs">bypass</Badge>;

    return <span className="text-xs text-muted-foreground">—</span>;
}

/** Badge for an instance's egress policy; deny-all is most locked-down, allow-all most open. */
export function egressBadge(egress: Doc<"sandboxInstances">["egress"]) {
    if (egress === "deny-all") return <Badge variant="success" className="text-xs">deny-all</Badge>;
    if (egress === "restricted") return <Badge variant="secondary" className="text-xs">restricted</Badge>;
    if (egress === "allow-all") return <Badge variant="warning" className="text-xs">allow-all</Badge>;

    return <span className="text-xs text-muted-foreground">—</span>;
}
