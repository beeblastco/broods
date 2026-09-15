"use client";

import { CopyButton } from "@/app/components/CopyButton";
import { DetailPanel } from "@/app/components/DetailSplit";
import {
  MACHINE_STATE_LABEL,
  machineStartCommand,
  machineState,
  type MachineConnection,
} from "@/app/lib/machineConnection";
import {
  DetailField,
  formatProvider,
  machineStatusDot,
  relativeTime,
} from "./sandboxFormat";

/** A user's computer: what its daemon last reported, and how to start it. */
export function MachinePanel({
  machine,
  now,
  onClose,
}: {
  machine: MachineConnection;
  /** The parent table's clock, so both tick together off one timer. */
  now: number;
  onClose: () => void;
}): React.JSX.Element {
  const state = machineState(machine, now);
  const serves = [
    "bash",
    ...(machine.computer ? ["computer use"] : []),
    ...machine.mcp.map((server): string => `mcp: ${server}`),
  ];
  const host = [machine.hostname, machine.platform].filter(Boolean).join(" · ");
  const command = machineStartCommand(machine.name, machine);

  return (
    <DetailPanel
      title={
        <span className="flex items-center gap-2">
          {machine.name}
          {machineStatusDot(state)}
        </span>
      }
      meta={
        <div className="mt-0.5 text-2xs text-muted-foreground">
          {formatProvider("machine")}
        </div>
      }
      onClose={onClose}
    >
      <div className="rounded-lg border border-border bg-card px-4">
        <DetailField label="Status" value={MACHINE_STATE_LABEL[state]} />
        <DetailField
          label="Host"
          value={<span className="break-all">{host || "—"}</span>}
        />
        <DetailField label="Serves" value={serves.join(", ")} />
        <DetailField
          label="Connected"
          value={relativeTime(machine.connectedAt, now)}
        />
        <DetailField
          label="Last seen"
          value={relativeTime(machine.lastSeenAt, now)}
        />
      </div>

      <div className="mt-5">
        <h4 className="text-sm font-medium text-foreground">
          Start it on that computer
        </h4>
        <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
          <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">
            {command}
          </code>
          <CopyButton value={command} label="command" />
        </div>
      </div>
    </DetailPanel>
  );
}
