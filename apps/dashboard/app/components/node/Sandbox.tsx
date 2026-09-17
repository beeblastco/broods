"use client";

/**
 * Sandbox node representing a standalone broods sandboxConfig record. A machine
 * sandbox shows its daemon's connection in place of the idle pill. Numbered by
 * its place in the agent's `sandboxes`: a chip inside a frame, or a card when
 * it is the only one of its kind.
 */
import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import {
  ResourceChip,
  type ChipStatus,
} from "@/app/components/node/ResourceChip";
import { useNow } from "@/app/hooks/useNow";
import { MACHINE_LABEL, machineStateByName } from "@/app/lib/machineConnection";
import { sandboxMemberStatus } from "@/app/lib/memberStatus";
import type { NodeProps } from "@xyflow/react";
import { Box, Monitor } from "lucide-react";
import { useMemo } from "react";

export function SandboxNode({
  id,
  data,
  parentId,
}: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const orderNumber = useCanvasFrames().sandboxOrderNumbers.get(id);
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
  const status = sandboxMemberStatus(nodeData, undefined);
  if (parentId !== undefined) {
    return (
      <SandboxChip
        id={id}
        data={nodeData}
        icon={<Box className="size-3.5" />}
        status={{ color: status.color, text: status.label }}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="sandbox"
      data={nodeData}
      icon={<Box className="size-3.5" />}
      subtitle={orderSubtitle(null, orderNumber)}
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
  const { machineConnections, sandboxOrderNumbers } = useCanvasFrames();
  const now = useNow();
  const state = machineStateByName(machineConnections, data.label, now);
  const status = sandboxMemberStatus(data, state);
  const liveStatus = { color: status.color, text: status.label };

  if (framed) {
    return (
      <SandboxChip
        id={id}
        data={data}
        icon={<Monitor className="size-3.5" />}
        status={liveStatus}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="sandbox"
      data={data}
      icon={<Box className="size-3.5" />}
      subtitle={orderSubtitle(MACHINE_LABEL, sandboxOrderNumbers.get(id))}
      liveStatus={state && liveStatus}
      showSideHandles={true}
    />
  );
}

/** A card's subtitle: where it runs, then its place in `sandboxes`, as its chip would say. */
function orderSubtitle(
  where: string | null,
  orderNumber: number | undefined,
): string | undefined {
  const parts = [
    ...(where === null ? [] : [where]),
    ...(orderNumber === undefined ? [] : [String(orderNumber)]),
    ...(orderNumber === 1 ? ["default"] : []),
  ];

  return parts.length > 0 ? parts.join(" · ") : undefined;
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
