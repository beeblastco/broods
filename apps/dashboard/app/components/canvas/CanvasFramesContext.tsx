"use client";

import type { StageMcpServer } from "@/app/lib/canvasFrameNodes";
import type { WorkspaceMountTarget } from "@/app/lib/canvasFrameEdits";
import type { MachineConnection } from "@/app/lib/machineConnection";
import type { AgentCanvasBadge } from "@broods/convex/model/agentConfigCodec";
import type { Id } from "@broods/convex/_generated/dataModel";
import { createContext, useContext } from "react";

export type CanvasFramesValue = {
  agentBadges:
    | Readonly<Record<Id<"agentConfigs">, AgentCanvasBadge>>
    | undefined;
  canWrite: boolean;
  expandedMemberId: string | null;
  machineConnections: readonly MachineConnection[] | undefined;
  mcpServers: ReadonlyMap<string, StageMcpServer>;
  /** Read on open, not held here: the rows depend on every edge, which a drag rewrites. */
  mountTargetsOf: (workspaceId: string) => WorkspaceMountTarget[];
  onSetWorkspaceMount: (
    workspaceId: string,
    target: WorkspaceMountTarget,
  ) => void;
  onRenameNode?: (nodeId: string, label: string) => void;
  onToggleFrame: (frameId: string) => void;
  /** 1-based place in `sandboxes`, only where all of a sandbox's agents agree. */
  sandboxOrderNumbers: ReadonlyMap<string, number>;
  workspaceOnlySandboxIds: ReadonlySet<string>;
};

const EMPTY_VALUE: CanvasFramesValue = {
  agentBadges: undefined,
  canWrite: false,
  expandedMemberId: null,
  machineConnections: undefined,
  mcpServers: new Map(),
  mountTargetsOf: () => [],
  onSetWorkspaceMount: () => {},
  onToggleFrame: () => {},
  sandboxOrderNumbers: new Map(),
  workspaceOnlySandboxIds: new Set(),
};

const CanvasFramesContext = createContext<CanvasFramesValue>(EMPTY_VALUE);

export const CanvasFramesProvider = CanvasFramesContext.Provider;

export function useCanvasFrames(): CanvasFramesValue {
  return useContext(CanvasFramesContext);
}
