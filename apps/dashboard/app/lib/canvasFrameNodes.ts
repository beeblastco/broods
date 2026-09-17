/**
 * Turns the flat canvas graph into what React Flow draws: sandbox, workspace
 * and MCP nodes an agent reaches sit as chips inside frame nodes, once two of
 * them share a group.
 *
 * The saved layout stays flat (one node per resource, absolute positions, one
 * edge per agent→member link). Frames, their slots and every edge drawn here
 * that is not in the flat list exist only on screen; `canvasFrameEdits.ts`
 * keeps flat positions in step with them when an edit changes a frame. Each
 * drawn agent and side edge carries its lanes in `data.route`, so no two edges
 * draw over each other.
 */
import type { api } from "@broods/convex/_generated/api";
import {
  agentEdgePoints,
  routeCanvasEdges,
  sideEdgePoints,
  type AgentEdgeRequest,
  type AgentEdgeRoute,
  type SideEdgeRequest,
  type SideEdgeRoute,
  type SideEnd,
} from "@broods/convex/model/canvasEdgeRoutes";
import {
  deriveCanvasGroups,
  edgeKind,
  FRAME_CHIP_HEIGHTS,
  FRAME_CHIP_WIDTH,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  FRAME_WIDTH,
  runsOnSandboxIds,
  workspaceSandboxIds,
  type CanvasFrame,
  type FrameKind,
  type McpServersByNode,
} from "@broods/convex/model/canvasFrames";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutRect,
} from "@broods/convex/model/canvasLayout";
import {
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import type { FunctionReturnType } from "convex/server";

/** Id prefix of the one edge drawn from an agent to a frame. */
export const BUNDLE_EDGE_PREFIX = "bundle:";

/** A collapsed frame is one compact card: header, member names, summary. */
export const COLLAPSED_FRAME_HEIGHT = 84;

const EDGE_CORNER_RADIUS = 8;

/** An agent edge's drawn data: its lanes, when the router placed it. */
export type AgentEdgeData = { route?: AgentEdgeRoute };

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

/**
 * A side edge's drawn data: its lanes, when the router placed it, and whether
 * it is drawn from other state rather than stored, so it offers no delete and
 * shows no lock.
 */
export type SideEdgeData = { displayOnly?: boolean; route?: SideEdgeRoute };

export type StageMcpServer = FunctionReturnType<
  typeof api.mcp.listByStage
>[number]; /**
 * Path of an agent edge from the agent's bottom handle to its target's top
 * handle along its lanes, as `[path, labelX, labelY]` like React Flow's path
 * helpers. The label sits on the gutter run, or on the final drop.
 */
export function agentEdgePath(
  source: XYPosition,
  target: XYPosition,
  route: AgentEdgeRoute,
): [string, number, number] {
  const points = agentEdgePoints(source, target, route);
  // The third leg is the gutter run, or the final drop when there is none.
  const [from, to] = [points[2], points[3]];

  return [roundedPath(points, EDGE_CORNER_RADIUS), from.x, (from.y + to.y) / 2];
}

/**
 * Flat nodes after React Flow's node changes. A measurement or selection
 * applies by id and moves nothing, so a layout saved before frames keeps its
 * stored positions until someone edits it. A position change is a drag: it
 * applies to the drawn graph and flattens back, so a dragged frame carries its
 * members and every member lands on its slot, which that drag then saves.
 */
export function applyFramedNodeChanges(
  changes: NodeChange[],
  nodes: Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[] | undefined,
  collapsed: ReadonlySet<string>,
): Node[] {
  if (!changes.some((change) => change.type === "position")) {
    return applyNodeChanges(changes, nodes);
  }
  // Nodes only: a drag moves no edge in flat state, so it routes none.
  const frames = framesOf(deriveGroups(nodes, edges, mcpServers));
  const displayNodes = framedNodes(
    nodes,
    frames,
    memberFrames(frames),
    collapsed,
  );

  return reuseUnchanged(
    nodes,
    flattenFramedNodes(applyNodeChanges(changes, displayNodes)),
    sameNode,
  );
}

/**
 * React Flow nodes and edges for display. Each frame comes right before its
 * first member, so React Flow sees every parent ahead of its children and
 * flattening restores the flat order. Members sit at their slots whatever
 * their stored positions. Every node and edge equal to one in `previous`
 * is that same object, so an unchanged frame or edge does not re-render.
 */
export function buildFramedGraph(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[] | undefined,
  collapsed: ReadonlySet<string>,
  previous: FramedGraph | null,
): FramedGraph {
  const frames = framesOf(deriveGroups(nodes, edges, mcpServers));
  const frameOf = memberFrames(frames);
  const displayNodes = framedNodes(nodes, frames, frameOf, collapsed);
  const drawn = framedEdges(
    nodes,
    edges,
    serversByNode(mcpServers ?? []),
    frameOf,
    collapsed,
  );

  return {
    bundles: drawn.bundles,
    edges: reuseUnchanged(
      previous?.edges ?? [],
      routeEdges(displayNodes, drawn.edges),
      sameEdge,
    ),
    frames: frames,
    nodes: reuseUnchanged(previous?.nodes ?? [], displayNodes, sameNode),
  };
}

/**
 * The groups of a flat graph, one-member groups included. MCP nodes stay
 * ungrouped until the stage's server list has loaded: before that each one
 * looks unsaved, so all of them would pack into one "MCP" frame and split
 * into overlapping frames when it lands.
 */
export function deriveGroups(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[] | undefined,
): CanvasFrame[] {
  return deriveCanvasGroups(
    mcpServers ? nodes : nodes.filter((node) => node.type !== "mcp"),
    edges,
    serversByNode(mcpServers ?? []),
  );
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

/** The stage's MCP rows keyed by the canvas node each one owns. */
export function serversByNode(
  mcpServers: readonly StageMcpServer[],
): Map<string, StageMcpServer> {
  return new Map(mcpServers.map((server) => [server.nodeId, server]));
}

/**
 * Path of a side edge between its two side handles along its lanes, as
 * `[path, labelX, labelY]`. The label sits on the middle run: the vertical
 * one of a straight step, or the run under the boxes of a detour.
 */
export function sideEdgePath(
  source: XYPosition,
  target: XYPosition,
  route: SideEdgeRoute,
): [string, number, number] {
  const points = sideEdgePoints(source, target, route);
  const middle = Math.floor((points.length - 1) / 2);
  const [from, to] = [points[middle], points[middle + 1]];

  return [
    roundedPath(points, EDGE_CORNER_RADIUS),
    (from.x + to.x) / 2,
    (from.y + to.y) / 2,
  ];
}

function addBundle(
  display: Edge[],
  bundles: Map<string, string[]>,
  agentId: string,
  frameId: string,
  edge: Edge,
): void {
  const id = `${BUNDLE_EDGE_PREFIX}${agentId}:${frameId}`;
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
 * Top-level boxes an agent edge runs between and around, and the box of every
 * visible node a side edge can end on, chips at their absolute place.
 */
function displayBoxes(displayNodes: readonly Node[]): {
  boxes: Map<string, LayoutRect>;
  handleBoxes: Map<string, { box: LayoutRect; outerId: string }>;
} {
  const byId = new Map(displayNodes.map((node) => [node.id, node]));
  const boxes = new Map<string, LayoutRect>();
  const handleBoxes = new Map<string, { box: LayoutRect; outerId: string }>();
  for (const node of displayNodes) {
    if (node.hidden) continue;
    if (node.parentId === undefined) {
      const box = {
        ...node.position,
        height: node.height ?? node.measured?.height ?? NODE_HEIGHT,
        width: node.width ?? node.measured?.width ?? NODE_WIDTH,
      };
      boxes.set(node.id, box);
      handleBoxes.set(node.id, { box: box, outerId: node.id });
      continue;
    }
    const parent = byId.get(node.parentId);
    if (!parent) continue;
    const kind: FrameKind =
      node.type === "workspace" || node.type === "mcp" ? node.type : "sandbox";
    handleBoxes.set(node.id, {
      box: {
        height: FRAME_CHIP_HEIGHTS[kind],
        width: FRAME_CHIP_WIDTH,
        x: parent.position.x + node.position.x,
        y: parent.position.y + node.position.y,
      },
      outerId: parent.id,
    });
  }

  return { boxes: boxes, handleBoxes: handleBoxes };
}

/**
 * Agent→member edges collapse into one bundle edge per agent and frame. Mount
 * and runs-on edges touching a collapsed frame's member re-point to the frame
 * on the same side. Runs-on edges come from the MCP rows: a machine server
 * points at the sandbox it runs on. A workspace with no mount of its own gets
 * a drawn edge to the sandbox it inherits.
 */
function framedEdges(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpServers: McpServersByNode,
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
      data: { ...edge.data, displayOnly: true },
      deletable: false,
      id: id,
      reconnectable: false,
      source: source,
      target: target,
    });
  }

  for (const edge of [
    ...inheritedEdges(nodes, edges, endpoint),
    ...runsOnEdges(nodes, mcpServers, endpoint),
  ]) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    display.push(edge);
  }

  return { bundles: bundles, edges: display };
}

/** Members get their frame as parent and a slot-relative position; frames go in before them. */
function framedNodes(
  nodes: readonly Node[],
  frames: readonly CanvasFrame[],
  frameOf: ReadonlyMap<string, CanvasFrame>,
  collapsed: ReadonlySet<string>,
): Node[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const frameNodes = new Map<string, FrameNodeType>();
  const slots = new Map<string, XYPosition>();
  for (const frame of frames) {
    const members = frame.memberIds.flatMap((id) => byId.get(id) ?? []);
    const isCollapsed = collapsed.has(frame.id);
    const size = isCollapsed
      ? { height: COLLAPSED_FRAME_HEIGHT, width: FRAME_WIDTH }
      : frameSize(frame);
    frameNodes.set(frame.id, {
      data: { collapsed: isCollapsed, frame: frame, members: members },
      height: size.height,
      id: frame.id,
      // Set up front: a frame object without `measured` makes React Flow
      // drop its handle bounds and measure it again.
      measured: size,
      position: frameOriginOf(members.map((member) => member.position)),
      type: "frame",
      width: size.width,
    });
    for (const [id, slot] of frameMemberPositions({ x: 0, y: 0 }, frame)) {
      slots.set(id, slot);
    }
  }
  const placed = new Set<string>();

  return nodes.flatMap((node): Node[] => {
    const frame = frameOf.get(node.id);
    const frameNode = frame ? frameNodes.get(frame.id) : undefined;
    if (!frame || !frameNode) return [node];
    const member: Node = {
      ...node,
      draggable: false,
      parentId: frame.id,
      position: slots.get(node.id) ?? { x: 0, y: 0 },
      ...(collapsed.has(frame.id) ? { hidden: true } : {}),
    };
    if (placed.has(frame.id)) return [member];
    placed.add(frame.id);

    return [frameNode, member];
  });
}

/**
 * Dashed edge from a workspace to each sandbox it inherits, facing it: one per
 * distinct default of the agents wired to it, since each agent runs the
 * workspace on its own. Drawn, never stored: the inheritance follows from the
 * agents' own edges.
 */
function inheritedEdges(
  nodes: readonly Node[],
  edges: readonly Edge[],
  endpoint: (id: string) => string,
): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return [...workspaceSandboxIds(nodes, edges)].flatMap(
    ([workspaceId, state]): Edge[] =>
      state.kind !== "inherited"
        ? []
        : state.sandboxIds.flatMap((sandboxId): Edge[] => {
            const workspace = byId.get(workspaceId);
            const sandbox = byId.get(sandboxId);
            const source = endpoint(workspaceId);
            const target = endpoint(sandboxId);
            if (!workspace || !sandbox || source === target) return [];

            return [
              sideEdge(
                `inherits:${source}-${target}`,
                source,
                target,
                workspace.position.x >= sandbox.position.x,
                "mount",
              ),
            ];
          }),
  );
}

/** Length of an axis-aligned leg. */
function legLength(a: XYPosition, b: XYPosition): number {
  return Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
}

/** Each framed node's frame, by member id. */
function memberFrames(
  frames: readonly CanvasFrame[],
): Map<string, CanvasFrame> {
  const frameOf = new Map<string, CanvasFrame>();
  for (const frame of frames) {
    for (const id of frame.memberIds) frameOf.set(id, frame);
  }

  return frameOf;
}

/**
 * `next` with every item equal to one in `previous` swapped for that object,
 * and `previous` itself when nothing changed at all.
 */
function reuseUnchanged<T extends { id: string }>(
  previous: T[],
  next: T[],
  same: (a: T, b: T) => boolean,
): T[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  let unchanged = previous.length === next.length;
  const reused = next.map((item, index) => {
    const prior = byId.get(item.id);
    if (!prior || !same(prior, item)) {
      unchanged = false;

      return item;
    }
    if (previous[index] !== prior) unchanged = false;

    return prior;
  });

  return unchanged ? previous : reused;
}

/**
 * An orthogonal polyline with its corners rounded. Repeated points are
 * dropped, and a corner's radius shrinks to fit the shorter of its two legs.
 */
function roundedPath(points: readonly XYPosition[], radius: number): string {
  const [first, ...rest] = points.filter(
    (point, index) =>
      index === 0 ||
      point.x !== points[index - 1].x ||
      point.y !== points[index - 1].y,
  );
  const commands = [`M${first.x} ${first.y}`];
  rest.forEach((point, index) => {
    const previous = index === 0 ? first : rest[index - 1];
    const next = rest[index + 1];
    if (!next) {
      commands.push(`L${point.x} ${point.y}`);

      return;
    }
    const corner = Math.min(
      radius,
      legLength(previous, point) / 2,
      legLength(point, next) / 2,
    );
    const before = stepToward(point, previous, corner);
    const after = stepToward(point, next, corner);
    commands.push(
      `L${before.x} ${before.y}`,
      `Q${point.x} ${point.y} ${after.x} ${after.y}`,
    );
  });

  return commands.join(" ");
}

/**
 * Display edges with their lanes in `data.route`: agent edges (bottom to top,
 * between two top-level boxes) and side edges (mount, inherited and runs-on,
 * between two side handles). Hidden members are no box; their edges already
 * re-point.
 */
function routeEdges(
  displayNodes: readonly Node[],
  edges: readonly Edge[],
): Edge[] {
  const byId = new Map(displayNodes.map((node) => [node.id, node]));
  const { boxes, handleBoxes } = displayBoxes(displayNodes);
  const agentEdges: AgentEdgeRequest[] = [];
  const sideEdges: SideEdgeRequest[] = [];
  const endOf = (
    nodeId: string,
    handle: string | null | undefined,
  ): SideEnd | null => {
    const placed = handleBoxes.get(nodeId);
    if (!placed || (handle !== "left" && handle !== "right")) return null;

    return {
      box: placed.box,
      nodeId: nodeId,
      outerId: placed.outerId,
      side: handle,
    };
  };
  for (const edge of edges) {
    if (edge.type === undefined || edge.type === "default") {
      if (
        byId.get(edge.source)?.type === "agent" &&
        byId.get(edge.target)?.type !== "agent"
      ) {
        agentEdges.push({
          id: edge.id,
          source: edge.source,
          target: edge.target,
        });
      }
      continue;
    }
    const source = endOf(edge.source, edge.sourceHandle);
    const target = endOf(edge.target, edge.targetHandle);
    if (edge.type === "subagent" || !source || !target) continue;
    sideEdges.push({ id: edge.id, source: source, target: target });
  }
  const routes = routeCanvasEdges(boxes, agentEdges, sideEdges);

  return edges.map((edge) => {
    const route = routes.agent.get(edge.id) ?? routes.side.get(edge.id);

    return route ? { ...edge, data: { ...edge.data, route: route } } : edge;
  });
}

/**
 * Dotted edge from each machine MCP server to the sandbox it runs on, the one
 * named by the row's `sandbox`. It leaves from the side facing that sandbox.
 */
function runsOnEdges(
  nodes: readonly Node[],
  mcpServers: McpServersByNode,
  endpoint: (id: string) => string,
): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));

  return [...runsOnSandboxIds(nodes, mcpServers)].flatMap(
    ([mcpId, sandboxId]): Edge[] => {
      const mcp = byId.get(mcpId);
      const sandbox = byId.get(sandboxId);
      if (!mcp || !sandbox) return [];
      const source = endpoint(mcpId);
      const target = endpoint(sandboxId);

      return [
        sideEdge(
          `runs-on:${source}-${target}`,
          source,
          target,
          mcp.position.x >= sandbox.position.x,
          "runsOn",
        ),
      ];
    },
  );
}

/** An edge's fields, and its style or data two levels down, where a route sits. */
function sameEdge(a: Edge, b: Edge): boolean {
  return sameValue(a, b, 4);
}

/**
 * A node's fields by value one level down (position, measured, style). A
 * frame's data is compared down to its member list, since it is rebuilt on
 * every change; any other node's data is the flat node's own object.
 */
function sameNode(a: Node, b: Node): boolean {
  return sameValue(a, b, a.type === "frame" && b.type === "frame" ? 4 : 2);
}

/**
 * Equal by identity, or arrays and plain objects whose entries are equal
 * this way, down to `depth` levels. Past that only identity counts.
 */
function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (a === b) return true;
  if (
    depth === 0 ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameValue(item, b[index], depth - 1))
    );
  }
  const entriesA = Object.entries(a);
  const entriesB = new Map<string, unknown>(Object.entries(b));

  return (
    entriesA.length === entriesB.size &&
    entriesA.every(
      ([key, value]) =>
        entriesB.has(key) && sameValue(value, entriesB.get(key), depth - 1),
    )
  );
}

/**
 * A drawn side edge nobody stores, deletes or reconnects, leaving the side of
 * its source that faces its target.
 */
function sideEdge(
  id: string,
  source: string,
  target: string,
  sourceOnRight: boolean,
  type: "mount" | "runsOn",
): Edge {
  return {
    data: { displayOnly: true },
    deletable: false,
    id: id,
    reconnectable: false,
    selectable: false,
    source: source,
    sourceHandle: sourceOnRight ? "left" : "right",
    target: target,
    targetHandle: sourceOnRight ? "right" : "left",
    type: type,
  };
}

/** The point `distance` along the axis-aligned leg from `from` to `to`. */
function stepToward(
  from: XYPosition,
  to: XYPosition,
  distance: number,
): XYPosition {
  return {
    x: from.x + Math.sign(to.x - from.x) * distance,
    y: from.y + Math.sign(to.y - from.y) * distance,
  };
}
