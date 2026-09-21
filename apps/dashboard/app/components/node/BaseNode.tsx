"use client";

import { useInfraAnalysis } from "@/app/components/canvas/InfraAnalysisContext";
import { DitherAvatarSVG } from "@/app/components/DitherAvatar";
import type { AgentHealthStatus } from "@/app/hooks/useAgentHealth";
import type { WorkspaceSandboxState } from "@/app/lib/canvasRuntimeRefs";
import type { MemberStatus } from "@/app/lib/memberStatus";
import { cn } from "@/app/lib/utils";
import type { FrameSlot } from "@broods/convex/model/canvasFrames";
import {
  CARD_STATUS_ROW,
  NODE_HEIGHT,
  workspaceStateText,
} from "@broods/convex/model/canvasLayout";
import { Handle, Position, useConnection, useStore } from "@xyflow/react";
import { Globe, Slash } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type BaseNodeData = {
  label: string;
  status?: "running" | "idle" | "error";
  agentConfigId?: string;
  resourceId?: string;
  mountName?: string;
  description?: string;
  config?: Record<string, unknown>;
  properties?: { color: string };
  /** Pulled out of its group by hand: it draws as a card, never as a chip. */
  ungrouped?: boolean;
  /** Where a drop put it, and in which group; unset means the sort decides. */
  frameSlot?: FrameSlot;
  // CLI-resolved forced read-only state for a workspace node (e.g. a `sandbox: null`
  // ref with no other writer). The pure-canvas graph can't express it, so analysis
  // honors this flag over the topology-inferred "inherited" state.
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

/** Text color of a workspace card's state line, per state. */
const STATE_TEXT_TONE: Record<WorkspaceSandboxState["kind"], string> = {
  inherited: "text-muted-foreground",
  override: "text-canvas-mount/90",
  readonly: "text-warning/90",
};

const zoomSelector = (state: { transform: [number, number, number] }): number =>
  state.transform[2];

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
  /** State shown once the node is wired: a machine's connection, an MCP server or skill's enabled flag, a workspace's mount. */
  liveStatus?: Pick<MemberStatus, "color" | "label">;
  /** Optional secondary row rendered under the label (e.g. sandbox provider badge). */
  subtitle?: React.ReactNode;
  /** Optional list of `+ feature` rows rendered between label and status pill. */
  featureRows?: { key: string; icon?: React.ReactNode; label: string }[];
  /** Render left/right handles for mount connections (workspace ↔ sandbox). */
  showSideHandles?: boolean;
}): React.JSX.Element {
  const zoom = useStore(zoomSelector);
  const scale = Math.min(Math.max(1 / Math.sqrt(zoom), 0.9), 1.2);

  const sideHandlesConnectable = useSideHandlesConnectable(nodeType);

  // Infra badges: workspace effective-sandbox state (B) and shared-agent count (F).
  const infraAnalysis = useInfraAnalysis();
  const workspaceState =
    nodeType === "workspace" ? infraAnalysis.workspaceStates[id] : undefined;
  const sharedAgentCount =
    nodeType === "workspace" || nodeType === "sandbox"
      ? (infraAnalysis.agentRefCounts[id] ?? 0)
      : 0;

  // The header content is counter-scaled to stay legible when zoomed out, but CSS
  // transforms don't reserve layout space, so we measure its unscaled height and
  // reserve `height * scale` on a wrapper, keeping it clear of the status pill.
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() =>
      setContentHeight(el.offsetHeight),
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  // Read from the one shared traversal. Walking the graph here instead ran a
  // per-node store selector on every ReactFlow update, drag frames included.
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
  // Everything under the name on one line: the subtitle, each feature, a
  // workspace's mount state, then how many agents share it.
  const details: React.ReactNode[] = [
    subtitle,
    ...(featureRows ?? []).map((row) => row.label),
    workspaceState && stateText !== null ? (
      <span className={STATE_TEXT_TONE[workspaceState.kind]}>{stateText}</span>
    ) : null,
    sharedAgentCount >= 2 ? `shared ×${sharedAgentCount}` : null,
    data.ungrouped === true ? "out of group" : null,
  ].filter((part) => part !== undefined && part !== null);
  const headerScale = fittedScale(scale, contentHeight);

  return (
    <div
      data-slot="card"
      data-min-height={NODE_HEIGHT}
      className={`relative w-44 h-(--card-height) flex flex-col rounded-md border bg-card transition duration-200 hover:shadow-md ${borderClass}`}
      style={{ "--card-height": `${NODE_HEIGHT}px` }}
    >
      {/* The explicit id matters: while connecting, xyflow resolves an id-less hovered
                handle to the node's FIRST handle (sources before targets) for the snap preview,
                which is the left side handle. The line would visually snap to the side even
                though the connection itself lands here on top. */}
      <Handle
        id="top"
        type="target"
        position={Position.Top}
        isConnectableStart={false}
        className="bg-transparent! w-2.5! h-2.5! border-transparent!"
      />

      {/* Agents source downward edges to services. Declared before the side handles so this
                no-id handle is the first source bound. xyflow resolves a handle-less edge to the
                first source handle, so plain agent→service edges land here, not on a side. */}
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
          {/* Held 48px down (SIDE_HANDLE_TOP in canvasEdgeRoutes.ts), so side edges between
              cards of different heights in one row run straight. An MCP card's sides only
              anchor its drawn runs-on edge; nothing mounts there. */}
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
        {/* Narrowed by the same scale, so the scaled header still ends at the card's edge. */}
        <div
          ref={contentRef}
          data-slot="card-header"
          className="px-3 pt-2.5 origin-top-left scale-(--node-scale) w-(--content-width)"
          style={{
            "--content-width": `${100 / headerScale}%`,
            "--node-scale": headerScale,
          }}
        >
          <div className="flex items-center gap-1.5 min-w-0">
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
            <span
              // One line, so every card is the same height; hover reads the whole name.
              className="text-xs font-medium text-foreground truncate min-w-0"
              title={data.label}
            >
              {data.label}
            </span>
          </div>
          {details.length > 0 && (
            <div className="mt-1 truncate text-2xs text-muted-foreground">
              {details.map((part, index) => (
                <span key={index}>
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
          {/* Down here, not in the title's corner, so a long name keeps the full width. */}
          {(nodeType === "agent" || nodeType === "sandbox") && (
            <NetworkBadge on={isNetworkOn(nodeType, data)} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Whether a node's network switch is on. A sandbox reads egress off
 * `network.mode` (allow-all or restricted is on, deny-all and unset are off),
 * which is how core models it; an agent reads public access, off by default.
 */
export function isNetworkOn(nodeType: string, data: BaseNodeData): boolean {
  if (nodeType !== "sandbox") return data.config?.publicAccess === true;
  const mode = (data.config?.network as { mode?: string } | undefined)?.mode;

  return mode === "allow-all" || mode === "restricted";
}

/** The globe on a sandbox or agent's status row, slashed while it is off. */
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

/**
 * Whether a node's side handles accept the connection being drawn. Side
 * handles must stay mounted at all times: existing mount/subagent edges attach
 * to them, and ReactFlow drops any edge whose handle disappears (edges used to
 * vanish mid-drag). So instead of unmounting them, mid-drag only the sides
 * matching the drag's intent accept the drop: workspace/sandbox sides serve
 * mounts; agent sides serve subagent (agent↔agent) links. Plain agent→service
 * edges still land on the top handle.
 */
export function useSideHandlesConnectable(nodeType: string): boolean {
  return useConnection((connection) => {
    if (!connection.inProgress) return true;
    const fromType = connection.fromNode?.type;
    const fromSide =
      connection.fromHandle?.id === "left" ||
      connection.fromHandle?.id === "right";

    // Gate by THIS node's type so the two side-handle relationships stay isolated: an agent's
    // sides serve only subagent links (another agent dragging from a side), and a
    // workspace/sandbox's sides serve only mounts. This way an agent never accepts an edge
    // during a mount drag, and a service never does during a subagent drag.
    if (nodeType === "agent") return fromType === "agent" && fromSide;

    return fromType === "workspace" || fromType === "sandbox";
  });
}

/**
 * The header's counter-scale, grown only as far as the measured header still
 * fits above the status row. The rows never wrap, so the measurement does not
 * change with the scale and cannot feed back into it.
 */
function fittedScale(scale: number, contentHeight: number | null): number {
  if (scale <= 1 || contentHeight === null || contentHeight <= 0) return scale;

  return Math.min(
    scale,
    Math.max(1, (NODE_HEIGHT - CARD_STATUS_ROW) / contentHeight),
  );
}

/** The text of a workspace card's state line, or null for any other card. */
function stateLine(state: WorkspaceSandboxState | undefined): string | null {
  if (!state) return null;

  return workspaceStateText(
    state.kind,
    state.kind === "readonly" ? [] : state.sandboxLabels,
  );
}
