"use client";

/**
 * Shared formatting + status-badge helpers for the Sandbox tab (instances and
 * snapshots). Keeps the instance/snapshot tables visually consistent.
 */

import { Badge } from "@/app/components/ui/badge";
import type { Doc } from "@broods/convex/_generated/dataModel";
import { useEffect, useState } from "react";

// A sandbox row changes state on the minute scale, so re-read the clock often
// enough that the displayed age is never more than a minute stale.
const CLOCK_TICK_MS = 30_000;

/**
 * Relative time that keeps minute resolution past the hour ("3h 07m ago"), because
 * a sandbox's age is what tells you whether it is idle or abandoned and "1h ago"
 * covers a whole hour of that. Em dash when unset. Pass `now` from `useNow()` so
 * the value keeps ticking between Convex updates.
 */
export function relativeTime(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const seconds = Math.max(0, Math.floor((now - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m ago`;

  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

/**
 * Ticking wall clock for the relative-time columns. Convex only re-renders a row
 * when its document changes, so without this an age freezes at whatever it read
 * when the row last moved.
 */
export function useNow(): number {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);

    return () => clearInterval(timer);
  }, []);

  return now;
}

/** Renders an instance's vcpu/memory/disk footprint as "1 vCPU · 2 GB · 8 GB". */
export function formatSpecs(specs: Doc<"sandboxInstances">["specs"]): string {
  const memory =
    specs.memoryMb >= 1024
      ? `${specs.memoryMb / 1024} GB`
      : `${specs.memoryMb} MB`;

  return `${specs.vcpu} vCPU · ${memory} · ${specs.storageGb} GB`;
}

/** Status badge for a live instance. */
export function instanceStatusBadge(status: Doc<"sandboxInstances">["status"]) {
  if (status === "running")
    return (
      <Badge variant="success" className="text-xs">
        running
      </Badge>
    );
  if (status === "suspended")
    return (
      <Badge variant="secondary" className="text-xs">
        suspended
      </Badge>
    );
  if (status === "suspending" || status === "terminating")
    return (
      <Badge variant="warning" className="text-xs">
        {status}
      </Badge>
    );

  return (
    <Badge variant="destructive" className="text-xs">
      error
    </Badge>
  );
}

/** Status badge for a snapshot/image's unified build status. */
export function snapshotStatusBadge(status: Doc<"sandboxSnapshots">["status"]) {
  if (status === "active")
    return (
      <Badge variant="success" className="text-xs">
        active
      </Badge>
    );
  if (status === "error" || status === "build_failed")
    return (
      <Badge variant="destructive" className="text-xs">
        {status}
      </Badge>
    );
  if (status === "inactive")
    return (
      <Badge variant="secondary" className="text-xs">
        inactive
      </Badge>
    );

  return (
    <Badge variant="warning" className="text-xs">
      {status}
    </Badge>
  );
}

/** Badge for an instance's tool-approval policy; em dash when the row predates the mirror. */
export function permissionModeBadge(
  mode: Doc<"sandboxInstances">["permissionMode"],
) {
  if (mode === "ask")
    return (
      <Badge variant="success" className="text-xs">
        ask
      </Badge>
    );
  if (mode === "edit")
    return (
      <Badge variant="warning" className="text-xs">
        edit
      </Badge>
    );
  if (mode === "bypass")
    return (
      <Badge variant="destructive" className="text-xs">
        bypass
      </Badge>
    );

  return <span className="text-xs text-muted-foreground">—</span>;
}

/** Badge for an instance's egress policy; deny-all is most locked-down, allow-all most open. */
export function egressBadge(egress: Doc<"sandboxInstances">["egress"]) {
  if (egress === "deny-all")
    return (
      <Badge variant="success" className="text-xs">
        deny-all
      </Badge>
    );
  if (egress === "restricted")
    return (
      <Badge variant="secondary" className="text-xs">
        restricted
      </Badge>
    );
  if (egress === "allow-all")
    return (
      <Badge variant="warning" className="text-xs">
        allow-all
      </Badge>
    );

  return <span className="text-xs text-muted-foreground">—</span>;
}
