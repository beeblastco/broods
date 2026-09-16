/**
 * Turns the flat canvas graph into what React Flow draws: sandbox, workspace
 * and MCP nodes an agent reaches sit as chips inside frame nodes.
 *
 * The saved layout stays flat (one node per resource, absolute positions, one
 * edge per agent→member link), so every edit is applied to the display graph
 * and flattened back before it lands in state. Frames and every edge drawn
 * here that is not in the flat list exist only on screen.
 */
import { isCodeManagedOwner } from "@/app/components/canvas/edgeOwnership";
import type { api } from "@broods/convex/_generated/api";
import {
  agentSandboxOrder,
  deriveCanvasFrames,
  edgeKind,
  frameMemberPositions,
  frameOriginOf,
  frameSize,
  FRAME_WIDTH,
  type CanvasFrame,
  type McpTransportsByNode,
} from "@broods/convex/model/canvasFrames";
import type { LayoutEdge, LayoutNode } from "@broods/convex/model/canvasLayout";
import type { Edge, EdgeChange, Node, XYPosition } from "@xyflow/react";
import type { FunctionReturnType } from "convex/server";

/** A collapsed frame is one compact card: header, member names, summary. */
export const COLLAPSED_FRAME_HEIGHT = 84;

/**
 * What a right-click on a chip can do, per agent that wires it directly.
 * `agentLabel` names the agent only when several do, so the entries differ.
 */
export type FrameMemberAction =
  | { kind: "make-default"; agentId: string; agentLabel: string | null }
  | { kind: "remove"; agentLabel: string | null; edgeId: string };

/** The display graph plus what the canvas needs to map edits back to flat state. */
export type FramedGraph = {
  /** Bundle edge id → the flat agent→member edge ids it stands for. */
  bundles: ReadonlyMap<string, string[]>;
  edges: Edge[];
  frames: CanvasFrame[];
  nodes: Node[];
};

export type FrameNodeData = {
  collapsed: boolean;
  frame: CanvasFrame;
  /** Flat member nodes in slot order, for the collapsed card's names and summary. */
  members: Node[];
};

export type FrameNodeType = Node<FrameNodeData, "frame">;

export type StageMcpServer = FunctionReturnType<
  typeof api.mcp.listByStage
>[number];

/**
 * React Flow nodes and edges for display. Each frame comes right before its
 * first member, so React Flow sees every parent ahead of its children and
 * flattening restores the flat order.
 */
export function buildFramedGraph(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[],
  collapsed: ReadonlySet<string>,
): FramedGraph {
  const transports = new Map(
    mcpServers.map((server) => [server.nodeId, server.transport]),
  );
  const frames = deriveCanvasFrames(nodes, edges, transports);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const frameOf = new Map<string, CanvasFrame>();
  for (const frame of frames) {
    for (const id of frame.memberIds) frameOf.set(id, frame);
  }

  return {
    ...framedEdges(nodes, edges, mcpServers, frameOf, collapsed),
    frames: frames,
    nodes: framedNodes(nodes, byId, frameOf, collapsed),
  };
}

/** Removing a bundle edge removes every agent→member edge it stands for. */
export function expandBundleEdgeRemoval(
  changes: readonly EdgeChange[],
  bundles: ReadonlyMap<string, string[]>,
): EdgeChange[] {
  return changes.flatMap((change): EdgeChange[] => {
    const edgeIds =
      change.type === "remove" ? bundles.get(change.id) : undefined;

    return edgeIds
      ? edgeIds.map((id) => ({ id: id, type: "remove" }))
      : [change];
  });
}

/** Display nodes back to flat state: no frames, members at absolute positions. */
export function flattenFramedNodes(displayNodes: readonly Node[]): Node[] {
  const frames = new Map(
    displayNodes
      .filter((node) => node.type === "frame")
      .map((node) => [node.id, node]),
  );

  return displayNodes.flatMap((node): Node[] => {
    if (node.type === "frame") return [];
    if (node.parentId === undefined) return [node];
    const frame = frames.get(node.parentId);
    const {
      draggable: _draggable,
      hidden: _hidden,
      parentId: _parentId,
      ...flat
    } = node;
    const position = frame
      ? {
          x: frame.position.x + node.position.x,
          y: frame.position.y + node.position.y,
        }
      : node.position;

    return [{ ...flat, position: position }];
  });
}

/**
 * Chip context menu entries. Make default only where the sandbox is not
 * already first and the agent is not code-managed (code owns its order);
 * remove only where the edge is not locked.
 */
export function frameMemberActions(
  nodes: readonly Node[],
  edges: readonly Edge[],
  memberId: string,
): FrameMemberAction[] {
  const member = nodes.find((node) => node.id === memberId);
  if (!member) return [];
  const agents = new Map(
    nodes
      .filter((node) => node.type === "agent")
      .map((node) => [node.id, node]),
  );
  const wired = edges.flatMap((edge) => {
    if (edgeKind(edge) !== "default") return [];
    const otherId =
      edge.source === memberId
        ? edge.target
        : edge.target === memberId
          ? edge.source
          : null;
    const agent = otherId === null ? undefined : agents.get(otherId);

    return agent ? [{ agent: agent, edge: edge }] : [];
  });
  const labelFor = (agent: Node): string | null =>
    wired.length > 1 && typeof agent.data.label === "string"
      ? agent.data.label
      : null;

  return wired.flatMap(({ agent, edge }): FrameMemberAction[] => {
    const actions: FrameMemberAction[] = [];
    if (
      member.type === "sandbox" &&
      !isCodeManagedOwner(agent.data.managedBy) &&
      agentSandboxOrder(agent, nodes, edges)[0] !== memberId
    ) {
      actions.push({
        agentId: agent.id,
        agentLabel: labelFor(agent),
        kind: "make-default",
      });
    }
    if (edge.deletable !== false) {
      actions.push({
        agentLabel: labelFor(agent),
        edgeId: edge.id,
        kind: "remove",
      });
    }

    return actions;
  });
}

/**
 * Where a node that just joined a frame should sit: its slot under the origin
 * the frame's other members already give it, so adding a card never moves the
 * frame. Null when the node frames alone or stays a card.
 */
export function joinedFramePosition(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpTransports: McpTransportsByNode,
  nodeId: string,
): XYPosition | null {
  const frame = deriveCanvasFrames(nodes, edges, mcpTransports).find((item) =>
    item.memberIds.includes(nodeId),
  );
  const others = nodes.filter(
    (node) => node.id !== nodeId && frame?.memberIds.includes(node.id),
  );
  if (!frame || others.length === 0) return null;

  return (
    frameMemberPositions(
      frameOriginOf(others.map((node) => node.position)),
      frame.memberIds,
    ).get(nodeId) ?? null
  );
}

/** Put a sandbox first in an agent's stored `sandboxOrder`, keeping the rest in order. */
export function makeDefaultSandbox<T extends LayoutNode>(
  nodes: readonly T[],
  edges: readonly LayoutEdge[],
  agentId: string,
  sandboxId: string,
): T[] {
  return nodes.map((node) => {
    if (node.id !== agentId) return node;
    const rest = agentSandboxOrder(node, nodes, edges).filter(
      (id) => id !== sandboxId,
    );

    return {
      ...node,
      data: { ...node.data, sandboxOrder: [sandboxId, ...rest] },
    };
  });
}

/**
 * `next` with every node that did not really change swapped for its previous
 * object, and `previous` itself when nothing changed. Rebuilding the display
 * graph copies every member; handing React Flow the old objects keeps it
 * from re-rendering every chip on each drag frame.
 */
export function reuseUnchangedNodes(previous: Node[], next: Node[]): Node[] {
  const byId = new Map(previous.map((node) => [node.id, node]));
  let unchanged = previous.length === next.length;
  const reused = next.map((node, index) => {
    const prior = byId.get(node.id);
    if (!prior || !sameNode(prior, node)) {
      unchanged = false;

      return node;
    }
    if (previous[index] !== prior) unchanged = false;

    return prior;
  });

  return unchanged ? previous : reused;
}

function addBundle(
  display: Edge[],
  bundles: Map<string, string[]>,
  agentId: string,
  frameId: string,
  edge: Edge,
): void {
  const id = `bundle:${agentId}:${frameId}`;
  const edgeIds = bundles.get(id);
  const locked = edge.deletable === false;
  if (!edgeIds) {
    bundles.set(id, [edge.id]);
    display.push({
      id: id,
      source: agentId,
      target: frameId,
      targetHandle: "top",
      ...(locked ? { deletable: false, reconnectable: false } : {}),
    });

    return;
  }
  edgeIds.push(edge.id);
  if (!locked) return;
  const index = display.findIndex((item) => item.id === id);
  display[index] = {
    ...display[index],
    deletable: false,
    reconnectable: false,
  };
}

/**
 * Agent→member edges collapse into one bundle edge per agent and frame. Mount
 * and runs-on edges touching a collapsed frame's member re-point to the frame
 * on the same side. Runs-on edges come from the MCP rows: a machine server
 * points at the sandbox it runs on.
 */
function framedEdges(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[],
  frameOf: ReadonlyMap<string, CanvasFrame>,
  collapsed: ReadonlySet<string>,
): Pick<FramedGraph, "bundles" | "edges"> {
  const agentIds = new Set(
    nodes.filter((node) => node.type === "agent").map((node) => node.id),
  );
  const endpoint = (id: string): string => {
    const frame = frameOf.get(id);

    return frame && collapsed.has(frame.id) ? frame.id : id;
  };
  const bundles = new Map<string, string[]>();
  const display: Edge[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    const kind = edgeKind(edge);
    const agentId = agentIds.has(edge.source)
      ? edge.source
      : agentIds.has(edge.target)
        ? edge.target
        : null;
    const serviceId = agentId === edge.source ? edge.target : edge.source;
    const frame = agentId === null ? undefined : frameOf.get(serviceId);
    if (kind === "default" && agentId !== null && frame) {
      addBundle(display, bundles, agentId, frame.id, edge);
      continue;
    }
    const source = endpoint(edge.source);
    const target = endpoint(edge.target);
    if (
      kind !== "mount" ||
      (source === edge.source && target === edge.target)
    ) {
      display.push(edge);
      continue;
    }
    const id = `collapsed:${source}-${edge.sourceHandle}-${target}-${edge.targetHandle}`;
    if (source === target || seen.has(id)) continue;
    seen.add(id);
    display.push({
      ...edge,
      deletable: false,
      id: id,
      reconnectable: false,
      source: source,
      target: target,
    });
  }

  for (const edge of runsOnEdges(nodes, mcpServers, endpoint)) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    display.push(edge);
  }

  return { bundles: bundles, edges: display };
}

/** Members get their frame as parent and a slot-relative position; frames go in before them. */
function framedNodes(
  nodes: readonly Node[],
  byId: ReadonlyMap<string, Node>,
  frameOf: ReadonlyMap<string, CanvasFrame>,
  collapsed: ReadonlySet<string>,
): Node[] {
  const placed = new Set<string>();

  return nodes.flatMap((node): Node[] => {
    const frame = frameOf.get(node.id);
    if (!frame) return [node];
    const members = frame.memberIds
      .map((id) => byId.get(id))
      .filter((member): member is Node => member !== undefined);
    const isCollapsed = collapsed.has(frame.id);
    const slot = frameMemberPositions({ x: 0, y: 0 }, frame.memberIds).get(
      node.id,
    ) ?? { x: 0, y: 0 };
    const member: Node = {
      ...node,
      draggable: false,
      parentId: frame.id,
      position: slot,
      ...(isCollapsed ? { hidden: true } : {}),
    };
    if (placed.has(frame.id)) return [member];
    placed.add(frame.id);
    const size = isCollapsed
      ? { height: COLLAPSED_FRAME_HEIGHT, width: FRAME_WIDTH }
      : frameSize(frame.memberIds.length);
    const frameNode: FrameNodeType = {
      data: { collapsed: isCollapsed, frame: frame, members: members },
      height: size.height,
      id: frame.id,
      // Set up front: a frame object is rebuilt on every change, and one
      // without `measured` makes React Flow drop its handle bounds and
      // measure it again.
      measured: size,
      position: frameOriginOf(members.map((item) => item.position)),
      type: "frame",
      width: size.width,
    };

    return [frameNode, member];
  });
}

/**
 * Dotted edge from a machine MCP server to the sandbox it runs on, the one
 * named by the row's `sandbox`. It leaves from the side facing that sandbox.
 */
function runsOnEdges(
  nodes: readonly Node[],
  mcpServers: readonly StageMcpServer[],
  endpoint: (id: string) => string,
): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return mcpServers.flatMap((server): Edge[] => {
    if (server.transport !== "machine" || server.sandbox === null) return [];
    const mcp = byId.get(server.nodeId);
    const sandbox = nodes.find(
      (node) =>
        node.type === "sandbox" &&
        (node.data.mountName ?? node.data.label) === server.sandbox,
    );
    if (!mcp || !sandbox) return [];
    const source = endpoint(mcp.id);
    const target = endpoint(sandbox.id);
    const mcpOnRight = mcp.position.x >= sandbox.position.x;

    return [
      {
        deletable: false,
        id: `runs-on:${source}-${target}`,
        reconnectable: false,
        selectable: false,
        source: source,
        sourceHandle: mcpOnRight ? "left" : "right",
        target: target,
        targetHandle: mcpOnRight ? "right" : "left",
        type: "runsOn",
      },
    ];
  });
}

/** Same fields by reference, positions by value. */
function sameNode(a: Node, b: Node): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);

  return [...keys].every((key) =>
    key === "position"
      ? a.position.x === b.position.x && a.position.y === b.position.y
      : a[key as keyof Node] === b[key as keyof Node],
  );
}
