"use client";

/**
 * Sandbox node representing a standalone broods sandboxConfig record. A machine
 * sandbox shows its daemon's connection in place of the idle pill.
 */
import { BaseNode, type BaseNodeData } from "@/app/components/node/BaseNode";
import { STATUS_TONE_BG } from "@/app/components/StatusDot";
import { useMachineConnection } from "@/app/hooks/useMachineConnection";
import { useNow } from "@/app/hooks/useNow";
import {
  MACHINE_LABEL,
  MACHINE_STATE_LABEL,
  MACHINE_TONE,
  machineState,
} from "@/app/lib/machineConnection";
import type { NodeProps } from "@xyflow/react";
import { Box } from "lucide-react";
import { useMemo } from "react";

export function SandboxNode({ id, data }: NodeProps): React.JSX.Element {
  const nodeData = data as BaseNodeData;
  const featureRows = useMemo(() => {
    if (nodeData.config?.persistent !== true) {
      return undefined;
    }

    return [{ key: "persistent", label: "persistent" }];
  }, [nodeData.config?.persistent]);

  if (nodeData.config?.provider === "machine") {
    return <MachineSandboxNode id={id} data={nodeData} />;
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

// Its own component, so only machine nodes run the clock and the query.
function MachineSandboxNode({
  id,
  data,
}: {
  id: string;
  data: BaseNodeData;
}): React.JSX.Element {
  const connection = useMachineConnection(data.label);
  const now = useNow();
  const state =
    connection === undefined ? undefined : machineState(connection, now);

  return (
    <BaseNode
      id={id}
      nodeType="sandbox"
      data={data}
      icon={<Box className="size-3.5" />}
      subtitle={MACHINE_LABEL}
      liveStatus={
        state && {
          color: STATUS_TONE_BG[MACHINE_TONE[state]],
          text: MACHINE_STATE_LABEL[state],
        }
      }
      showSideHandles={true}
    />
  );
}
