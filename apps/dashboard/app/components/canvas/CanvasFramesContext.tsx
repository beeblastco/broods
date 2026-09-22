"use client";

/**
 * Stage data the canvas node cards and edges read, queried once by the Canvas
 * instead of once per card: the stage's MCP servers, its machine connections,
 * each wired sandbox's order number and which sandboxes only back a workspace.
 * Also carries the frame collapse toggle, which chip is open, and the mount
 * menu a workspace's edge offers. The UI gallery provides a static value, so
 * cards render with no Convex behind them.
 */
import type { StageMcpServer } from "@/app/lib/canvasFrameNodes";
import type { WorkspaceMountTarget } from "@/app/lib/canvasFrameEdits";
import type { MachineConnection } from "@/app/lib/machineConnection";
import { createContext, useContext } from "react";

export type CanvasFramesValue = {
  /** A reader reads the mount word; only a writer opens its menu. */
  canWrite: boolean;
  /** The selected chip, drawn as a card in a card's slot; null when none is. */
  expandedMemberId: string | null;
  /** Undefined while loading. */
  machineConnections: readonly MachineConnection[] | undefined;
  /** By canvas node id. */
  mcpServers: ReadonlyMap<string, StageMcpServer>;
  /**
   * Where a workspace can mount, read when its menu opens rather than held on
   * this value: the rows depend on every edge, which a drag rewrites.
   */
  mountTargetsOf: (workspaceId: string) => WorkspaceMountTarget[];
  onSetWorkspaceMount: (
    workspaceId: string,
    target: WorkspaceMountTarget,
  ) => void;
  onToggleFrame: (frameId: string) => void;
  /** Sandbox node id → 1-based place in `sandboxes`, where all its agents agree. */
  sandboxOrderNumbers: ReadonlyMap<string, number>;
  /** Sandbox node ids a workspace mounts and no agent wires. */
  workspaceOnlySandboxIds: ReadonlySet<string>;
};

const EMPTY_VALUE: CanvasFramesValue = {
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
