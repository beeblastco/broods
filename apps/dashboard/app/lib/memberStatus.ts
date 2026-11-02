import {
  statusConfig,
  type BaseNodeData,
} from "@/app/components/node/BaseNode";
import { STATUS_TONE_BG } from "@/app/components/StatusDot";
import type { WorkspaceSandboxState } from "@/app/lib/canvasRuntimeRefs";
import {
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  type MachineState,
} from "@/app/lib/machineConnection";

const LEVEL_RANK: Record<MemberLevel, number> = {
  idle: 0,
  ok: 1,
  warn: 2,
  error: 3,
};

const MACHINE_LEVEL: Record<MachineState, MemberLevel> = {
  connected: "ok",
  never: "idle",
  offline: "warn",
};

const RUN_LEVEL: Record<NonNullable<BaseNodeData["status"]>, MemberLevel> = {
  error: "error",
  idle: "idle",
  running: "ok",
};

export const WORKSPACE_STATE_LABEL: Record<
  WorkspaceSandboxState["kind"],
  string
> = {
  inherited: "inherited",
  override: "mounted",
  readonly: "read-only",
};

export type MemberLevel = "error" | "idle" | "ok" | "warn";

export type MemberStatus = { color: string; label: string; level: MemberLevel };

export function enabledMemberStatus(enabled: boolean): MemberStatus {
  return enabled
    ? { color: "bg-success", label: "Enabled", level: "ok" }
    : { color: statusConfig.idle.color, label: "Disabled", level: "idle" };
}

export function sandboxMemberStatus(
  data: BaseNodeData,
  machine: MachineState | undefined,
): MemberStatus {
  if (machine) {
    return {
      color: STATUS_TONE_BG[MACHINE_TONE[machine]],
      label: MACHINE_STATE_LABEL[machine],
      level: MACHINE_LEVEL[machine],
    };
  }
  const status = data.status ?? "idle";

  return {
    color: statusConfig[status].color,
    label: statusConfig[status].text,
    level: RUN_LEVEL[status],
  };
}

export function summarizeMembers(statuses: readonly MemberStatus[]): {
  color: string;
  text: string;
} {
  const top = statuses.reduce<MemberStatus | undefined>(
    (best, status) =>
      best === undefined || LEVEL_RANK[status.level] > LEVEL_RANK[best.level]
        ? status
        : best,
    undefined,
  );
  const counts = new Map<string, number>();
  for (const { label } of statuses) {
    const word = label.toLowerCase();
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  return {
    color: top?.color ?? statusConfig.idle.color,
    text: [...counts].map(([word, count]) => `${count} ${word}`).join(" · "),
  };
}

export function workspaceMemberStatus(
  state: WorkspaceSandboxState | undefined,
): MemberStatus {
  if (!state) {
    return {
      color: statusConfig.idle.color,
      label: statusConfig.idle.text,
      level: "idle",
    };
  }
  if (state.kind === "readonly") {
    return {
      color: "bg-warning",
      label: WORKSPACE_STATE_LABEL.readonly,
      level: "warn",
    };
  }

  return state.kind === "override"
    ? {
        color: "bg-canvas-mount",
        label: WORKSPACE_STATE_LABEL.override,
        level: "ok",
      }
    : {
        color: statusConfig.idle.color,
        label: WORKSPACE_STATE_LABEL.inherited,
        level: "idle",
      };
}
