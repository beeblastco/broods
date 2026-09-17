"use client";

/**
 * Sandbox node representing a standalone broods sandboxConfig record. A machine
 * sandbox shows its daemon's connection in place of the idle pill. Inside a
 * frame it draws as a chip numbered by its place in the agent's `sandboxes`.
 */
import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import {
  BaseNode,
  statusConfig,
  type BaseNodeData,
} from "@/app/components/node/BaseNode";
import {
  ResourceChip,
  type ChipStatus,
} from "@/app/components/node/ResourceChip";
import { STATUS_TONE_BG } from "@/app/components/StatusDot";
import { useNow } from "@/app/hooks/useNow";
import {
  MACHINE_LABEL,
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  machineStateByName,
} from "@/app/lib/machineConnection";
import type { NodeProps } from "@xyflow/react";
import { Box, Monitor } from "lucide-react";
import { useMemo } from "react";

export function SandboxNode({
  id,
  data,
  parentId,
}: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const featureRows = useMemo(() => {
    if (nodeData.config?.persistent !== true) {
      return undefined;
    }

    return [{ key: "persistent", label: "persistent" }];
  }, [nodeData.config?.persistent]);

  if (nodeData.config?.provider === "machine") {
    return (
      <MachineSandboxNode
        id={id}
        data={nodeData}
        framed={parentId !== undefined}
      />
    );
  }
  if (parentId !== undefined) {
    return (
      <SandboxChip
        id={id}
        data={nodeData}
        icon={<Box className="size-3.5" />}
        status={statusConfig[nodeData.status ?? "idle"]}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="sandbox"
      data={nodeData}
      icon={<Box className="size-3.5" />}
      featureRows={featureRows}
      showSideHandles={true}
    />
  );
}

// Its own component, so only machine nodes run the clock.
function MachineSandboxNode({
  id,
  data,
  framed,
}: {
  id: string;
  data: BaseNodeData;
  framed: boolean;
}): React.JSX.Element {
  const { machineConnections } = useCanvasFrames();
  const now = useNow();
  const state = machineStateByName(machineConnections, data.label, now);
  const liveStatus = state && {
    color: STATUS_TONE_BG[MACHINE_TONE[state]],
    text: MACHINE_STATE_LABEL[state],
  };

  if (framed) {
    return (
      <SandboxChip
        id={id}
        data={data}
        icon={<Monitor className="size-3.5" />}
        status={liveStatus ?? statusConfig.idle}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="sandbox"
      data={data}
      icon={<Box className="size-3.5" />}
      subtitle={MACHINE_LABEL}
      liveStatus={liveStatus}
      showSideHandles={true}
    />
  );
}

/**
 * A chip numbered by its place in its agents' order; the first is the default,
 * so its chip says so. A shared sandbox whose agents order it differently has
 * no one number, so it says how many agents share it instead.
 */
function SandboxChip({
  id,
  data,
  icon,
  status,
}: {
  id: string;
  data: BaseNodeData;
  icon: React.ReactNode;
  status: ChipStatus;
}): React.JSX.Element {
  const orderNumber = useCanvasFrames().sandboxOrderNumbers.get(id);
  const sharedCount = useInfraAnalysis().agentRefCounts[id] ?? 0;
  const note =
    orderNumber === 1
      ? " · default"
      : orderNumber === undefined && sharedCount > 1
        ? ` · shared ×${sharedCount}`
        : "";

  return (
    <ResourceChip
      icon={icon}
      label={data.label}
      mountable={true}
      nodeType="sandbox"
      orderNumber={orderNumber}
      status={{ color: status.color, text: `${status.text}${note}` }}
    />
  );
}
