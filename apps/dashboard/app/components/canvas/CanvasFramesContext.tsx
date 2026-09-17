"use client";

/**
 * Stage data the canvas node cards read, queried once by the Canvas instead of
 * once per card: the stage's MCP servers, its machine connections, each
 * wired sandbox's order number and which sandboxes only back a workspace. Also
 * carries the frame collapse toggle. The UI gallery provides a static value, so
 * cards render with no Convex behind them.
 */
import type { StageMcpServer } from "@/app/lib/canvasFrameNodes";
import type { MachineConnection } from "@/app/lib/machineConnection";
import { createContext, useContext } from "react";

export type CanvasFramesValue = {
  /** Undefined while loading. */
  machineConnections: readonly MachineConnection[] | undefined;
  /** By canvas node id. */
  mcpServers: ReadonlyMap<string, StageMcpServer>;
  onToggleFrame: (frameId: string) => void;
  /** Sandbox node id → 1-based place in `sandboxes`, where all its agents agree. */
  sandboxOrderNumbers: ReadonlyMap<string, number>;
  /** Sandbox node ids a workspace mounts and no agent wires. */
  workspaceOnlySandboxIds: ReadonlySet<string>;
};

const EMPTY_VALUE: CanvasFramesValue = {
  machineConnections: undefined,
  mcpServers: new Map(),
  onToggleFrame: () => {},
  sandboxOrderNumbers: new Map(),
  workspaceOnlySandboxIds: new Set(),
};

const CanvasFramesContext = createContext<CanvasFramesValue>(EMPTY_VALUE);

export const CanvasFramesProvider = CanvasFramesContext.Provider;

export function useCanvasFrames(): CanvasFramesValue {
  return useContext(CanvasFramesContext);
}
