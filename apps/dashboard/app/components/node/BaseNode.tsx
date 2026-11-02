"use client";

import { useCanvasFrames } from "@/app/components/canvas/CanvasFramesContext";
import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import { DitherAvatarSVG } from "@/app/components/DitherAvatar";
import { InlineEdit } from "@/app/components/ui/inline-edit";
import type { AgentHealthStatus } from "@/app/hooks/useAgentHealth";
import type { WorkspaceSandboxState } from "@/app/lib/canvasRuntimeRefs";
import type { MemberStatus } from "@/app/lib/memberStatus";
import { observeResize } from "@/app/lib/observeResize";
import { cn } from "@/app/lib/utils";
import type { FrameSlot } from "@broods/convex/model/canvasFrames";
import {
  CARD_STATUS_ROW,
  NODE_HEIGHT,
  workspaceStateText,
} from "@broods/convex/model/canvasLayout";
import { Handle, Position, useConnection, useStore } from "@xyflow/react";
import { Globe, Slash } from "lucide-react";
import { useCallback, useState } from "react";

export type BaseNodeData = {
  label: string;
  status?: "running" | "idle" | "error";
  agentConfigId?: string;
  resourceId?: string;
  managedBy?: string;
  mountName?: string;
  description?: string;
  config?: Record<string, unknown>;
  properties?: { color: string };
  ungrouped?: boolean;
  frameSlot?: FrameSlot;
  /** Set by the CLI (a `sandbox: null` ref); analysis prefers it over the inferred state. */
  readOnly?: boolean;
};

export const statusConfig = {
  running: { color: "bg-success", text: "Running" },
  idle: { color: "bg-muted-foreground", text: "Idle" },
  error: { color: "bg-destructive", text: "Error" },
};

export const agentStatusConfig: Record<
  AgentHealthStatus,
  { color: string; text: string }
> = {
  healthy: { color: "bg-success", text: "Healthy" },
  deploying: { color: "bg-warning", text: "Deploying" },
  idle: { color: "bg-muted-foreground", text: "Idle" },
  unhealthy: { color: "bg-destructive", text: "Unhealthy" },
};

const STATE_TEXT_TONE: Record<WorkspaceSandboxState["kind"], string> = {
  inherited: "text-muted-foreground",
  override: "text-canvas-mount/90",
  readonly: "text-warning/90",
};

// Rounded here, so a node renders on a visible size change, not on every zoom frame.
const scaleSelector = (state: {
  transform: [number, number, number];
}): number =>
  Math.round(
    Math.min(Math.max(1 / Math.sqrt(state.transform[2]), 0.9), 1.2) * 100,
  ) / 100;

export function BaseNode({
  id,
  nodeType,
  data,
  icon,
  agentStatus,
  liveStatus,
  subtitle,
  featureRows,
  showSideHandles,
}: {
  id: string;
  nodeType: string;
  data: BaseNodeData;
  icon: React.ReactNode;
  agentStatus?: AgentHealthStatus;
  liveStatus?: Pick<MemberStatus, "color" | "label">;
  subtitle?: React.ReactNode;
  featureRows?: { key: string; icon?: React.ReactNode; label: string }[];
  showSideHandles?: boolean;
}): React.JSX.Element {
  const scale = useStore(scaleSelector);
  const { canWrite, onRenameNode } = useCanvasFrames();
  const [renaming, setRenaming] = useState(false);

  const sideHandlesConnectable = useSideHandlesConnectable(nodeType);

  const infraAnalysis = useInfraAnalysis();
  const workspaceState =
    nodeType === "workspace" ? infraAnalysis.workspaceStates[id] : undefined;
  const sharedAgentCount =
    nodeType === "workspace" || nodeType === "sandbox"
      ? (infraAnalysis.agentRefCounts[id] ?? 0)
      : 0;

  // A transform reserves no space: measure the unscaled header, reserve height * scale.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const measureContent = useCallback(
    (el: HTMLDivElement | null) =>
      el
        ? observeResize(el, () => setContentHeight(el.offsetHeight))
        : undefined,
    [],
  );

  // From the shared traversal: a per-node graph walk ran on every ReactFlow update.
  const isConnectedToAgent =
    nodeType === "agent" || (infraAnalysis.connectedToAgent[id] ?? false);

  let statusColor = "";
  let statusText = "";
  let showStatus = true;

  if (nodeType === "agent" && agentStatus) {
    const config = agentStatusConfig[agentStatus];
    statusColor = config.color;
    statusText = config.text;
  } else if (!isConnectedToAgent) {
    statusColor = "bg-destructive";
    statusText = "Unconnected";
  } else if (liveStatus) {
    statusColor = liveStatus.color;
    statusText = liveStatus.label;
  } else {
    const config = statusConfig[data.status ?? "idle"];
    statusColor = config.color;
    statusText = config.text;
  }

  const borderClass = !isConnectedToAgent
    ? "border-destructive/40 hover:border-destructive/60"
    : "border-border hover:border-foreground/25";
  const stateText = stateLine(workspaceState);
  const details: Array<{ key: string; part: React.ReactNode }> = [
    { key: "subtitle", part: subtitle },
    ...(featureRows ?? []).map((row) => ({
      key: `feature:${row.key}`,
      part: row.label,
    })),
    {
      key: "state",
      part:
        workspaceState && stateText !== null ? (
          <span className={STATE_TEXT_TONE[workspaceState.kind]}>
            {stateText}
          </span>
        ) : null,
    },
    {
      key: "shared",
      part: sharedAgentCount >= 2 ? `shared ×${sharedAgentCount}` : null,
    },
    {
      key: "ungrouped",
      part: data.ungrouped === true ? "out of group" : null,
    },
  ].filter(({ part }) => part !== undefined && part !== null);
  const headerScale = fittedScale(scale, contentHeight);

  return (
    <div
      data-slot="card"
      data-min-height={NODE_HEIGHT}
      className={`relative w-44 h-(--card-height) flex flex-col rounded-md border bg-card transition duration-200 hover:shadow-md ${borderClass}`}
      style={{ "--card-height": `${NODE_HEIGHT}px` }}
    >
      {/* Keeps its id: xyflow previews an id-less handle's snap at the first one, a side. */}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectableStart={false}
        className="bg-transparent! w-2.5! h-2.5! border-transparent!"
      />

      {/* Before the side handles: xyflow lands a handle-less edge on the first source. */}
      {nodeType === "agent" && (
        <Handle
          type="source"
          position={Position.Bottom}
          isConnectableEnd={false}
          className="bg-transparent! w-2.5! h-2.5! border-transparent!"
        />
      )}

      {showSideHandles && (
        <>
          {/* top-12 is SIDE_HANDLE_TOP (canvasEdgeRoutes.ts); MCP sides only anchor runs-on. */}
          <Handle
            id="left"
            type="source"
            position={Position.Left}
            isConnectable={nodeType !== "mcp"}
            isConnectableEnd={sideHandlesConnectable}
            className="top-12! bg-transparent! w-2.5! h-2.5! border-transparent!"
          />
          <Handle
            id="right"
            type="source"
            position={Position.Right}
            isConnectable={nodeType !== "mcp"}
            isConnectableEnd={sideHandlesConnectable}
            className="top-12! bg-transparent! w-2.5! h-2.5! border-transparent!"
          />
        </>
      )}

      <div
        className="h-(--content-height)"
        style={{
          "--content-height":
            contentHeight != null
              ? `${contentHeight * headerScale}px`
              : undefined,
        }}
      >
        <div
          ref={measureContent}
          data-slot="card-header"
          className="px-3 pt-2.5 origin-top-left scale-(--node-scale) w-(--content-width)"
          style={{
            "--content-width": `${100 / headerScale}%`,
            "--node-scale": headerScale,
          }}
        >
          <div
            className={cn(
              "flex items-center gap-1.5 min-w-0 text-xs font-medium",
              renaming && "nodrag nopan",
            )}
          >
            {nodeType === "agent" ? (
              <DitherAvatarSVG
                seed={data.label}
                size={14}
                className="shrink-0"
              />
            ) : data.properties?.color ? (
              <span
                className="inline-block size-3 rounded-full shrink-0 bg-(--dot-color)"
                style={{ "--dot-color": data.properties.color }}
              />
            ) : (
              <span className="text-muted-foreground shrink-0">{icon}</span>
            )}
            {renaming && onRenameNode ? (
              <InlineEdit
                value={data.label}
                label={`Rename ${data.label}`}
                onCommit={(label) => {
                  setRenaming(false);
                  onRenameNode(id, label);
                }}
                onCancel={() => setRenaming(false)}
              />
            ) : (
              <span
                className="text-xs font-medium text-foreground truncate min-w-0"
                title={data.label}
                onDoubleClick={
                  canWrite && onRenameNode ? () => setRenaming(true) : undefined
                }
              >
                {data.label}
              </span>
            )}
          </div>
          {details.length > 0 && (
            <div className="mt-1 truncate text-2xs text-muted-foreground">
              {details.map(({ key, part }, index) => (
                <span key={key}>
                  {index > 0 && " · "}
                  {part}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {showStatus && (
        <div
          data-slot="card-status"
          className="mt-auto px-3 pt-2 pb-2.5 flex items-center gap-1.5"
        >
          <div className={`size-1.5 rounded-full ${statusColor}`} />
          <span className="text-2xs text-muted-foreground">{statusText}</span>
          {(nodeType === "agent" || nodeType === "sandbox") && (
            <NetworkBadge on={isNetworkOn(nodeType, data)} />
          )}
        </div>
      )}
    </div>
  );
}

export function isNetworkOn(nodeType: string, data: BaseNodeData): boolean {
  if (nodeType !== "sandbox") return data.config?.publicAccess === true;
  const mode = (data.config?.network as { mode?: string } | undefined)?.mode;

  return mode === "allow-all" || mode === "restricted";
}

export function NetworkBadge({ on }: { on: boolean }): React.JSX.Element {
  return (
    <span className="relative ml-auto inline-flex size-5 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background/90">
      <Globe
        className={cn(
          "size-3.5",
          on ? "text-success" : "text-muted-foreground",
        )}
      />
      {!on && (
        <Slash className="pointer-events-none absolute size-3.5 text-muted-foreground" />
      )}
    </span>
  );
}

// Side handles never unmount, since ReactFlow drops an edge whose handle goes:
// mid-drag, agent sides take only subagent links and the others only mounts.
export function useSideHandlesConnectable(nodeType: string): boolean {
  return useConnection((connection) => {
    if (!connection.inProgress) return true;
    const fromType = connection.fromNode?.type;
    const fromSide =
      connection.fromHandle?.id === "left" ||
      connection.fromHandle?.id === "right";

    if (nodeType === "agent") return fromType === "agent" && fromSide;

    return fromType === "workspace" || fromType === "sandbox";
  });
}

// Rows never wrap, so the measured height cannot feed back into the scale.
function fittedScale(scale: number, contentHeight: number | null): number {
  if (scale <= 1 || contentHeight === null || contentHeight <= 0) return scale;

  return Math.min(
    scale,
    Math.max(1, (NODE_HEIGHT - CARD_STATUS_ROW) / contentHeight),
  );
}

function stateLine(state: WorkspaceSandboxState | undefined): string | null {
  if (!state) return null;

  return workspaceStateText(
    state.kind,
    state.kind === "readonly" ? [] : state.sandboxLabels,
  );
}
