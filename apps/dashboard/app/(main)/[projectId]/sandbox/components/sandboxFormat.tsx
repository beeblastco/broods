"use client";

import { StatusDot, type StatusTone } from "@/app/components/StatusDot";
import { Badge } from "@/app/components/ui/badge";
import { HelpMark } from "@/app/components/HelpMark";
import {
  MACHINE_LABEL,
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  type MachineState,
} from "@/app/lib/machineConnection";
import { tabHref } from "@/app/lib/navigation";
import type { Doc, Id } from "@broods/convex/_generated/dataModel";
import { ExternalLink } from "lucide-react";
import Link from "next/link";

export const INSTANCE_TONE: Record<
  Doc<"sandboxInstances">["status"],
  StatusTone
> = {
  running: "ok",
  suspending: "running",
  suspended: "ended",
  terminating: "running",
  error: "error",
};

const PROVIDER_LABEL: Record<string, string> = {
  machine: MACHINE_LABEL,
  sandbox: "workdir",
};

const UNKNOWN_DISK: Record<string, string> = {
  e2b: "E2B does not report a sandbox's disk size.",
  machine: "Your own computer: its OS did not report the size of its disk.",
  vercel: "Vercel does not report a sandbox's disk size.",
};

const UNKNOWN_SIZE: Record<string, string> = {
  daytona:
    "Daytona sizes this sandbox itself and has not reported its size yet. It shows the next time this sandbox is used.",
  e2b: "The E2B template sizes this sandbox, and Broods reads that size only when the sandbox is created. This one predates that or the read failed, so it stays unknown until the sandbox is recreated.",
  worker:
    "A V8 Worker has no machine: each command runs in a V8 isolate with 128 MB of memory, and nothing runs between commands.",
  machine:
    "Your own computer: its broods CLI predates hardware reporting. Update broods and restart `broods machine` to see it.",
  sandbox:
    "Workdir fixes the size when it creates the VM, and this one was created before Broods recorded it. It stays unknown until the sandbox is recreated.",
  vercel:
    "Vercel sizes this sandbox itself and has not reported its size. It shows once Vercel reports it.",
};

const UNVERIFIED_SIZE =
  "Recorded before Broods checked sandbox sizes. The real size shows the next time this sandbox is used.";

export const SNAPSHOT_TONE: Record<
  Doc<"sandboxSnapshots">["status"],
  StatusTone
> = {
  pending: "running",
  building: "running",
  pulling: "running",
  active: "ok",
  inactive: "ended",
  error: "error",
  build_failed: "error",
};

// An ephemeral instance lives only for its call; one without a config link predates actions.
export function controllable(
  instance: Doc<"sandboxInstances">,
): instance is Doc<"sandboxInstances"> & {
  sandboxConfigId: Id<"sandboxConfigs">;
} {
  return Boolean(instance.sandboxConfigId) && instance.ephemeral !== true;
}

export function dashboardHref(
  projectId: Id<"projects">,
  stage: string | null,
  { tab, ...params }: { tab: string } & Record<string, string>,
): string {
  const search = new URLSearchParams(stage ? { stage: stage } : {});

  return tabHref(`/${projectId}/dashboard`, tab, search.toString(), params);
}

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

export function machineStatusDot(state: MachineState): React.JSX.Element {
  return (
    <StatusDot tone={MACHINE_TONE[state]} label={MACHINE_STATE_LABEL[state]} />
  );
}

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

// Minutes past the hour ("3h 07m ago"): a sandbox's age tells idle from abandoned.
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
    return <HelpMark text={UNKNOWN_SIZE[provider] ?? UNVERIFIED_SIZE} />;
  }
  const memory =
    specs.memoryMb >= 1024
      ? `${Math.round((specs.memoryMb / 1024) * 10) / 10} GB`
      : `${specs.memoryMb} MB`;

  return (
    <span>
      {specs.vcpu} vCPU · {memory} ·{" "}
      {specs.storageGb === undefined ? (
        <HelpMark
          text={
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

export function TraceLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      draggable={false}
      onClick={(event) => event.stopPropagation()}
      className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap text-foreground/80 transition-colors hover:text-foreground hover:underline"
    >
      {children}
      <ExternalLink className="size-3 shrink-0" />
    </Link>
  );
}
