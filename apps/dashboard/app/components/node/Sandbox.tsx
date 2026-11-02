"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import {
  BaseNode,
  isNetworkOn,
  type BaseNodeData,
} from "@/app/components/node/BaseNode";
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

const WORKSPACE_ONLY_NOTE = "workspace only";

export function SandboxNode({
  id,
  data,
  parentId,
}: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const { sandboxOrderNumbers, workspaceOnlySandboxIds } = useCanvasFrames();
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
      subtitle={orderSubtitle(
        null,
        sandboxOrderNumbers.get(id),
        workspaceOnlySandboxIds.has(id),
      )}
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
  const { machineConnections, sandboxOrderNumbers, workspaceOnlySandboxIds } =
    useCanvasFrames();
  const now = useNow();
  const state = machineStateByName(machineConnections, data.label, now);
  const status = sandboxMemberStatus(data, state);

  if (framed) {
    return (
      <SandboxChip
        id={id}
        data={data}
        icon={<Monitor className="size-3.5" />}
        status={{ color: status.color, text: status.label }}
      />
    );
  }

  return (
    <BaseNode
      id={id}
      nodeType="sandbox"
      data={data}
      icon={<Box className="size-3.5" />}
      subtitle={orderSubtitle(
        MACHINE_LABEL,
        sandboxOrderNumbers.get(id),
        workspaceOnlySandboxIds.has(id),
      )}
      liveStatus={state && status}
      showSideHandles={true}
    />
  );
}

function chipDetails(
  subtitle: string | undefined,
  persistent: boolean,
): string | undefined {
  const parts = [subtitle, persistent ? "persistent" : null].filter(
    (part): part is string => typeof part === "string",
  );

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function chipNote(
  orderNumber: number | undefined,
  sharedCount: number,
  workspaceOnly: boolean,
): string {
  if (orderNumber === 1) return " · default";
  if (orderNumber !== undefined) return "";
  if (sharedCount > 1) return ` · shared ×${sharedCount}`;

  return workspaceOnly ? ` · ${WORKSPACE_ONLY_NOTE}` : "";
}

function orderSubtitle(
  where: string | null,
  orderNumber: number | undefined,
  workspaceOnly: boolean,
): string | undefined {
  const parts = [
    where,
    orderNumber === 1 ? "default" : null,
    orderNumber === undefined && workspaceOnly ? WORKSPACE_ONLY_NOTE : null,
  ].filter((part): part is string => typeof part === "string");

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The frame stacks members in their agents' order, so only the top chip says "default". A
 * shared sandbox its agents order differently has no one place: it says how many share it.
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
  const { expandedMemberId, sandboxOrderNumbers, workspaceOnlySandboxIds } =
    useCanvasFrames();
  const orderNumber = sandboxOrderNumbers.get(id);
  const sharedCount = useInfraAnalysis().agentRefCounts[id] ?? 0;
  const workspaceOnly = workspaceOnlySandboxIds.has(id);
  const expanded = expandedMemberId === id;
  const note = expanded
    ? ""
    : chipNote(orderNumber, sharedCount, workspaceOnly);

  return (
    <ResourceChip
      details={chipDetails(
        orderSubtitle(null, orderNumber, workspaceOnly),
        data.config?.persistent === true,
      )}
      expanded={expanded}
      icon={icon}
      label={data.label}
      mountable={true}
      networkOn={isNetworkOn("sandbox", data)}
      nodeType="sandbox"
      status={{ color: status.color, text: `${status.text}${note}` }}
    />
  );
}
