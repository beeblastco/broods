/**
 * Turns the flat canvas graph into what React Flow draws: sandbox, workspace
 * and MCP nodes an agent reaches sit as chips inside frame nodes.
 *
 * The saved layout stays flat (one node per resource, absolute positions, one
 * edge per agent→member link). Frames, their slots and every edge drawn here
 * that is not in the flat list exist only on screen; `canvasFrameEdits.ts`
 * keeps flat positions in step with them when an edit changes a frame.
 */
import type { api } from "@broods/convex/_generated/api";
import {
  deriveCanvasFrames,
  edgeKind,
  frameMemberPositions,
  frameOriginOf,
  frameSize,
  FRAME_WIDTH,
  type CanvasFrame,
} from "@broods/convex/model/canvasFrames";
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

/** How far below the agent a bundle edge turns sideways: the middle of the gap above the first row. */
const BUNDLE_BUS_DROP = 24;

const BUNDLE_CORNER_RADIUS = 8;

/**
 * How far left of its frame a bundle edge runs down. The column gutter is 40
 * wide and mount and runs-on edges cross it at its centre, so the trunk keeps
 * to the frame's side of that.
 */
const BUNDLE_TRUNK_INSET = 10;

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
  const graph = buildFramedGraph(nodes, edges, mcpServers, collapsed, null);

  return reuseUnchanged(
    nodes,
    flattenFramedNodes(applyNodeChanges(changes, graph.nodes)),
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
  const frames = deriveFrames(nodes, edges, mcpServers);
  const frameOf = new Map<string, CanvasFrame>();
  for (const frame of frames) {
    for (const id of frame.memberIds) frameOf.set(id, frame);
  }
  const drawn = framedEdges(nodes, edges, mcpServers ?? [], frameOf, collapsed);

  return {
    bundles: drawn.bundles,
    edges: reuseUnchanged(previous?.edges ?? [], drawn.edges, sameEdge),
    frames: frames,
    nodes: reuseUnchanged(
      previous?.nodes ?? [],
      framedNodes(nodes, frames, frameOf, collapsed),
      sameNode,
    ),
  };
}

/**
 * Path of a bundle edge from the agent's bottom handle to a frame's left
 * handle, as `[path, labelX, labelY]` like React Flow's path helpers. It drops
 * to a bus under the agent, runs along it to the frame's gutter, then down the
 * gutter and into the frame, so it never crosses a frame stacked above its
 * target. A generic step path turns at the midpoint instead, through whatever
 * sits there.
 */
export function bundleEdgePath(
  source: XYPosition,
  target: XYPosition,
): [string, number, number] {
  const busY = source.y + BUNDLE_BUS_DROP;
  const trunkX = target.x - BUNDLE_TRUNK_INSET;
  const path = roundedPath(
    [
      source,
      { x: source.x, y: busY },
      { x: trunkX, y: busY },
      { x: trunkX, y: target.y },
      target,
    ],
    BUNDLE_CORNER_RADIUS,
  );

  return [path, trunkX, (busY + target.y) / 2];
}

/**
 * The frames of a flat graph. MCP nodes stay cards until the stage's server
 * list has loaded: before that each one looks unsaved, so all of them would
 * pack into one "MCP" frame and split into overlapping frames when it lands.
 */
export function deriveFrames(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[] | undefined,
): CanvasFrame[] {
  const transports = new Map(
    (mcpServers ?? []).map((server) => [server.nodeId, server.transport]),
  );

  return deriveCanvasFrames(
    mcpServers ? nodes : nodes.filter((node) => node.type !== "mcp"),
    edges,
    transports,
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
      targetHandle: "left",
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
      : frameSize(frame.memberIds.length);
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
    for (const [id, slot] of frameMemberPositions(
      { x: 0, y: 0 },
      frame.memberIds,
    )) {
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

/** Length of an axis-aligned leg. */
function legLength(a: XYPosition, b: XYPosition): number {
  return Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
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

/** An edge's fields, and its style or data one level down. */
function sameEdge(a: Edge, b: Edge): boolean {
  return sameValue(a, b, 2);
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
