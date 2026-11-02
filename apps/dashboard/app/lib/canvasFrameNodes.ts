// The saved layout stays flat: frames, their slots and the edges drawn here exist only on
// screen, and `canvasFrameEdits.ts` keeps flat positions in step when an edit moves a frame.
import type { api } from "@broods/convex/_generated/api";
import {
  agentEdgePoints,
  ARROW_RUN,
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
  FRAME_CHIP_HEIGHT,
  FRAME_CHIP_WIDTH,
  FRAME_MEMBER_CARD_HEIGHT,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  runsOnSandboxIds,
  workspaceSandboxIds,
  type CanvasFrame,
  type McpServersByNode,
} from "@broods/convex/model/canvasFrames";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutRect,
} from "@broods/convex/model/canvasLayout";
import {
  applyNodeChanges,
  getSmoothStepPath,
  type Edge,
  type EdgeChange,
  type GetSmoothStepPathParams,
  type Node,
  type NodeChange,
  type XYPosition,
} from "@xyflow/react";
import type { FunctionReturnType } from "convex/server";

export const BUNDLE_EDGE_PREFIX = "bundle:";

export const COLLAPSED_FRAME_HEIGHT = NODE_HEIGHT;

// No node carries it: it sits in a member list only so the frame leaves a gap for a drop.
export const DROP_SLOT_ID = "canvas-drop-slot";

const EDGE_CORNER_RADIUS = 8;

export type AgentEdgeData = { route?: AgentEdgeRoute };

export type FramedGraph = {
  bundles: ReadonlyMap<string, string[]>;
  edges: Edge[];
  frames: CanvasFrame[];
  nodes: Node[];
};

export type FrameNodeData = {
  collapsed: boolean;
  /** Only for a drop it accepts; `slotY` is null while collapsed. */
  drop?: { slotY: number | null };
  frame: CanvasFrame;
  members: Node[];
};

export type FrameNodeType = Node<FrameNodeData, "frame">;

export type PendingDrop = { frameId: string; slot: number };

export type DrawnEdgeKind = "collapsed" | "inherited" | "runsOn";

export type SideEdgeData = { drawn?: DrawnEdgeKind; route?: SideEdgeRoute };

export type StageMcpServer = FunctionReturnType<
  typeof api.mcp.listByStage
>[number];

export function agentEdgePath(
  source: XYPosition,
  target: XYPosition,
  route: AgentEdgeRoute,
): [string, number, number] {
  const points = agentEdgePoints(source, target, route);
  // The label sits on the third leg: the gutter run, or the final drop when there is none.
  const [from, to] = [points[2], points[3]];

  return [roundedPath(points, EDGE_CORNER_RADIUS), from.x, (from.y + to.y) / 2];
}

export function applyFramedNodeChanges(
  changes: NodeChange[],
  nodes: Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[] | undefined,
  collapsed: ReadonlySet<string>,
): Node[] {
  // Only a drag re-flattens, so a layout saved before frames keeps its positions.
  if (!changes.some((change) => change.type === "position")) {
    return applyNodeChanges(changes, nodes);
  }
  // No open chip: its taller slot must never be written into the saved layout.
  const frames = framesOf(deriveGroups(nodes, edges, mcpServers));
  const displayNodes = framedNodes(
    nodes,
    frames,
    memberFrames(frames),
    collapsed,
    null,
    null,
  );

  return reuseUnchanged(
    nodes,
    flattenFramedNodes(applyNodeChanges(changes, displayNodes)),
    sameNode,
  );
}

export function buildFramedGraph(
  nodes: readonly Node[],
  edges: readonly Edge[],
  mcpServers: readonly StageMcpServer[] | undefined,
  collapsed: ReadonlySet<string>,
  expandedMemberId: string | null,
  previous: FramedGraph | null,
  pendingDrop?: PendingDrop | null,
): FramedGraph {
  const frames = framesOf(deriveGroups(nodes, edges, mcpServers));
  const frameOf = memberFrames(frames);
  const displayNodes = framedNodes(
    nodes,
    frames,
    frameOf,
    collapsed,
    expandedMemberId,
    pendingDrop ?? null,
  );
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
      routeEdges(displayNodes, drawn.edges, expandedMemberId),
      sameEdge,
    ),
    frames: frames,
    nodes: reuseUnchanged(previous?.nodes ?? [], displayNodes, sameNode),
  };
}

// MCP nodes stay ungrouped until the server list loads: each looks unsaved before, so
// all would pack into one frame and then split into overlapping ones.
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

export function facingHandles(
  source: Node | undefined,
  target: Node | undefined,
): Pick<Edge, "sourceHandle" | "targetHandle"> {
  const sourceOnRight =
    source !== undefined &&
    target !== undefined &&
    source.position.x >= target.position.x;

  return {
    sourceHandle: sourceOnRight ? "left" : "right",
    targetHandle: sourceOnRight ? "right" : "left",
  };
}

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
      className: _className,
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

export function serversByNode(
  mcpServers: readonly StageMcpServer[],
): Map<string, StageMcpServer> {
  return new Map(mcpServers.map((server) => [server.nodeId, server]));
}

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

export function stepEdgePath(
  params: Omit<GetSmoothStepPathParams, "borderRadius" | "offset">,
): [string, number, number] {
  const [path, labelX, labelY] = getSmoothStepPath({
    ...params,
    borderRadius: EDGE_CORNER_RADIUS,
    offset: ARROW_RUN,
  });

  return [path, labelX, labelY];
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

function displayBoxes(
  displayNodes: readonly Node[],
  expandedMemberId: string | null,
): {
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
    handleBoxes.set(node.id, {
      box: {
        height:
          node.id === expandedMemberId
            ? FRAME_MEMBER_CARD_HEIGHT
            : FRAME_CHIP_HEIGHT,
        width: FRAME_CHIP_WIDTH,
        x: parent.position.x + node.position.x,
        y: parent.position.y + node.position.y,
      },
      outerId: parent.id,
    });
  }

  return { boxes: boxes, handleBoxes: handleBoxes };
}

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
  const byId = new Map(nodes.map((node) => [node.id, node]));
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
    if (kind !== "mount") {
      display.push(edge);
      continue;
    }
    // Faced from where its ends stand, not its stored handles, so it steps straight.
    const handles = facingHandles(byId.get(edge.source), byId.get(edge.target));
    const source = endpoint(edge.source);
    const target = endpoint(edge.target);
    if (source === edge.source && target === edge.target) {
      display.push({ ...edge, ...handles });
      continue;
    }
    const id = `collapsed:${source}-${handles.sourceHandle}-${target}-${handles.targetHandle}`;
    if (source === target || seen.has(id)) continue;
    seen.add(id);
    display.push({
      ...edge,
      ...handles,
      data: { ...edge.data, drawn: "collapsed" },
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

// React Flow needs every parent ahead of its children, so a frame precedes its first member.
function framedNodes(
  nodes: readonly Node[],
  frames: readonly CanvasFrame[],
  frameOf: ReadonlyMap<string, CanvasFrame>,
  collapsed: ReadonlySet<string>,
  expandedMemberId: string | null,
  pendingDrop: PendingDrop | null,
): Node[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const frameNodes = new Map<string, FrameNodeType>();
  const slots = new Map<string, XYPosition>();
  for (const frame of frames) {
    const members = frame.memberIds.flatMap((id) => byId.get(id) ?? []);
    const isCollapsed = collapsed.has(frame.id);
    const expanded = isCollapsed ? undefined : (expandedMemberId ?? undefined);
    const taking = pendingDrop !== null && pendingDrop.frameId === frame.id;
    const pending = taking && !isCollapsed ? pendingDrop.slot : null;
    const shape =
      pending === null
        ? frame
        : {
            kind: frame.kind,
            memberIds: withDropSlot(frame.memberIds, pending),
          };
    const size = isCollapsed
      ? { height: COLLAPSED_FRAME_HEIGHT, width: NODE_WIDTH }
      : frameSize(shape, expanded);
    const slotPositions = frameMemberPositions({ x: 0, y: 0 }, shape, expanded);
    const dropSlot = slotPositions.get(DROP_SLOT_ID);
    frameNodes.set(frame.id, {
      data: {
        collapsed: isCollapsed,
        frame: frame,
        members: members,
        ...(taking ? { drop: { slotY: dropSlot?.y ?? null } } : {}),
      },
      height: size.height,
      id: frame.id,
      // Without `measured`, React Flow drops the frame's handle bounds and re-measures it.
      measured: size,
      position: frameOriginOf(members.map((member) => member.position)),
      type: "frame",
      width: size.width,
    });
    for (const [id, slot] of slotPositions) {
      if (id !== DROP_SLOT_ID) slots.set(id, slot);
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
                facingHandles(workspace, sandbox),
                "inherited",
              ),
            ];
          }),
  );
}

function legLength(a: XYPosition, b: XYPosition): number {
  return Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
}

function memberFrames(
  frames: readonly CanvasFrame[],
): Map<string, CanvasFrame> {
  const frameOf = new Map<string, CanvasFrame>();
  for (const frame of frames) {
    for (const id of frame.memberIds) frameOf.set(id, frame);
  }

  return frameOf;
}

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

function routeEdges(
  displayNodes: readonly Node[],
  edges: readonly Edge[],
  expandedMemberId: string | null,
): Edge[] {
  const byId = new Map(displayNodes.map((node) => [node.id, node]));
  const { boxes, handleBoxes } = displayBoxes(displayNodes, expandedMemberId);
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
    sideEdges.push({
      id: edge.id,
      // Side edge ids lead with their kind: mount, inherits, runs-on, collapsed.
      kind: edge.id.slice(0, edge.id.indexOf(":")),
      source: source,
      target: target,
    });
  }
  const routes = routeCanvasEdges(boxes, agentEdges, sideEdges);

  return edges.map((edge) => {
    const route = routes.agent.get(edge.id) ?? routes.side.get(edge.id);

    return route ? { ...edge, data: { ...edge.data, route: route } } : edge;
  });
}

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
          facingHandles(mcp, sandbox),
          "runsOn",
        ),
      ];
    },
  );
}

function sameEdge(a: Edge, b: Edge): boolean {
  return sameValue(a, b, 4);
}

// A frame's data is rebuilt on every change, so it compares deeper, down to its members.
function sameNode(a: Node, b: Node): boolean {
  return sameValue(a, b, a.type === "frame" && b.type === "frame" ? 4 : 2);
}

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

function sideEdge(
  id: string,
  source: string,
  target: string,
  handles: Pick<Edge, "sourceHandle" | "targetHandle">,
  drawn: Exclude<DrawnEdgeKind, "collapsed">,
): Edge {
  return {
    ...handles,
    data: { drawn: drawn },
    deletable: false,
    id: id,
    reconnectable: false,
    selectable: false,
    source: source,
    target: target,
    type: drawn === "runsOn" ? "runsOn" : "mount",
  };
}

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

export function withDropSlot(
  memberIds: readonly string[],
  slot: number,
): string[] {
  const ids = [...memberIds];
  ids.splice(slot, 0, DROP_SLOT_ID);

  return ids;
}
