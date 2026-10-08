"use client";

import { StatusDot, type StatusTone } from "@/app/components/StatusDot";
import { Badge } from "@/app/components/ui/badge";
import { IconTooltip } from "@/app/components/IconTooltip";
import {
  MACHINE_LABEL,
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  type MachineState,
} from "@/app/lib/machineConnection";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";

// Same four tones as the tracing panel: sky while the provider is still moving
// (suspending, terminating, building), grey once nothing runs. Tables and
// titles show the dot only; the detail view spells the word out.
const INSTANCE_TONE: Record<Doc<"sandboxInstances">["status"], StatusTone> = {
  running: "ok",
  suspending: "running",
  suspended: "ended",
  terminating: "running",
  error: "error",
};

// What users see for a stored provider when it differs from the stored name.
const PROVIDER_LABEL: Record<string, string> = {
  machine: MACHINE_LABEL,
  sandbox: "workdir",
};

// Why a machine's disk is not shown, by provider; the "?" in its place says it.
const UNKNOWN_DISK: Record<string, string> = {
  e2b: "E2B does not report a sandbox's disk size.",
  machine: "Your own computer: its OS did not report the size of its disk.",
  vercel: "Vercel does not report a sandbox's disk size.",
};

// Why a machine shows no size at all, by provider. Daytona and Vercel report
// on every use; e2b is read and workdir fixed only when the sandbox is created.
const UNKNOWN_SIZE: Record<string, string> = {
  daytona:
    "Daytona sizes this sandbox itself and has not reported its size yet. It shows the next time this sandbox is used.",
  e2b: "The E2B template sizes this sandbox, and Broods reads that size only when the sandbox is created. This one predates that or the read failed, so it stays unknown until the sandbox is recreated.",
  machine:
    "Your own computer: its broods CLI predates hardware reporting. Update broods and restart `broods machine` to see it.",
  sandbox:
    "Workdir fixes the size when it creates the VM, and this one was created before Broods recorded it. It stays unknown until the sandbox is recreated.",
  vercel:
    "Vercel sizes this sandbox itself and has not reported its size yet. It shows the next time this sandbox is used.",
};

// Why a lambda or cloudflare size is unknown: the row predates verified sizes.
const UNVERIFIED_SIZE =
  "Recorded before Broods checked sandbox sizes. The real size shows the next time this sandbox is used.";

const SNAPSHOT_TONE: Record<Doc<"sandboxSnapshots">["status"], StatusTone> = {
  pending: "running",
  building: "running",
  pulling: "running",
  active: "ok",
  inactive: "ended",
  error: "error",
  build_failed: "error",
};

/** Deep link into the project dashboard, keeping the stage the page is on. */
export function dashboardHref(
  projectId: Id<"projects">,
  stage: string | null,
  params: Record<string, string>,
): string {
  const next = new URLSearchParams();
  if (stage) next.set("stage", stage);
  for (const [key, value] of Object.entries(params)) next.set(key, value);

  return `/${projectId}/dashboard?${next.toString()}`;
}

/** One label and value row of a detail panel. */
export function DetailField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border py-2 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-right text-xs text-foreground">{value}</span>
    </div>
  );
}

/**
 * Badge variant tracks how open the policy is, from deny-all locked down to
 * allow-all wide open.
 */
export function egressBadge(
  egress: Doc<"sandboxInstances">["egress"],
): React.JSX.Element {
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

export function formatProvider(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider;
}

export function instanceStatusDot(
  status: Doc<"sandboxInstances">["status"],
): React.JSX.Element {
  return <StatusDot tone={INSTANCE_TONE[status]} label={status} />;
}

export function machineStatusDot(state: MachineState): React.JSX.Element {
  return (
    <StatusDot tone={MACHINE_TONE[state]} label={MACHINE_STATE_LABEL[state]} />
  );
}

/** Em dash when the row predates the permission-mode mirror. */
export function permissionModeBadge(
  mode: Doc<"sandboxInstances">["permissionMode"],
): React.JSX.Element {
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

export function snapshotStatusDot(
  status: Doc<"sandboxSnapshots">["status"],
): React.JSX.Element {
  return <StatusDot tone={SNAPSHOT_TONE[status]} label={status} />;
}

/**
 * Footprint, e.g. "1 vCPU · 2 GB · 8 GB", shown only when `verified` says it is
 * the machine's real size. Anything unknown is a "?" whose tooltip says why.
 * Sizes the table rows and the instance and computer panels.
 */
export function SpecsValue({
  specs,
  verified,
  provider,
}: {
  specs: Doc<"sandboxInstances">["specs"] | undefined;
  verified: boolean;
  provider: string;
}): React.JSX.Element {
  if (!specs || !verified) {
    return <UnknownSize reason={UNKNOWN_SIZE[provider] ?? UNVERIFIED_SIZE} />;
  }
  const memory =
    specs.memoryMb >= 1024
      ? `${Math.round((specs.memoryMb / 1024) * 10) / 10} GB`
      : `${specs.memoryMb} MB`;

  return (
    <span>
      {specs.vcpu} vCPU · {memory} ·{" "}
      {specs.storageGb === undefined ? (
        <UnknownSize
          reason={
            UNKNOWN_DISK[provider] ??
            "The provider does not report its disk size."
          }
        />
      ) : (
        `${specs.storageGb} GB`
      )}
    </span>
  );
}

// A "?" for a size Broods cannot know; hover or focus it to read why. The click
// stays here so it does not also open the row it sits in.
function UnknownSize({ reason }: { reason: string }): React.JSX.Element {
  return (
    <IconTooltip label={reason}>
      <button
        type="button"
        className="cursor-help"
        onClick={(event) => event.stopPropagation()}
      >
        ?
      </button>
    </IconTooltip>
  );
}
