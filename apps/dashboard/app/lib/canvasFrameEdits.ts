import {
  connectionEdge,
  isCodeManagedOwner,
} from "@/app/components/canvas/edgeOwnership";
import type { BaseNodeData } from "@/app/components/node/BaseNode";
import {
  deriveGroups,
  facingHandles,
  type StageMcpServer,
} from "@/app/lib/canvasFrameNodes";
import {
  defaultRuntimeNodeData,
  runtimeRefsProblems,
  type RuntimeRefsProblem,
} from "@/app/lib/canvasRuntimeRefs";
import {
  agentSandboxOrder,
  edgeKind,
  frameGroupOf,
  frameMemberPositions,
  frameOriginOf,
  framesOf,
  frameSize,
  workspaceSandboxIds,
  type CanvasFrame,
  type FrameSize,
} from "@broods/convex/model/canvasFrames";
import {
  findFreePosition,
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutEdge,
  type LayoutNode,
  type LayoutRect,
} from "@broods/convex/model/canvasLayout";
import type { Edge, Node, XYPosition } from "@xyflow/react";

export const CARD_SIZE: FrameSize = { height: NODE_HEIGHT, width: NODE_WIDTH };

type DeferredFrame = { desired: XYPosition; frame: CanvasFrame };

export type FlatGraph = {
  edges: Edge[];
  /** Undefined while loading; MCP nodes are not framed until then. */
  mcpServers: readonly StageMcpServer[] | undefined;
  nodes: Node[];
};

export type FrameGroupAction = {
  frameLabel: string;
  kind: "pull-out" | "rejoin" | "ungroup-all";
  nodeIds: string[];
};

export type NodeLinkAction =
  | {
      kind: "make-default";
      agentId: string;
      agentLabel: string | null;
      disabledReason: string | null;
    }
  | {
      kind: "unlink";
      edgeId: string;
      label: string;
      locked: boolean;
      mount: boolean;
      otherType: Node["type"];
    };

// `readonly` sets the flag for a `sandbox: null` ref: no mount edge already means inherit.
export type WorkspaceMountTarget =
  | { current: boolean; kind: "default" }
  | { current: boolean; kind: "readonly" }
  | { current: boolean; kind: "sandbox"; label: string; sandboxId: string };

export function acceptsNewMember(frame: CanvasFrame): boolean {
  const group = frameGroupOf(
    {
      data: defaultRuntimeNodeData(frame.kind, "", "new"),
      id: "new",
      type: frame.kind,
    },
    new Map(),
  );

  return group !== null && group.key === frame.key;
}

// A code-managed agent's wiring comes from its manifest, so a canvas edge would lie.
export function autoWiredAgentIds(
  nodes: readonly Node[],
  agentIds: readonly string[],
): string[] {
  return agentIds.filter(
    (id) =>
      !isCodeManagedOwner(nodes.find((node) => node.id === id)?.data.managedBy),
  );
}

// A collapsed frame counts at its expanded size, so nothing lands where it opens.
export function boardRects(
  displayNodes: readonly Node[],
  frames: readonly CanvasFrame[],
): LayoutRect[] {
  const sizes = new Map(frames.map((frame) => [frame.id, frameSize(frame)]));

  return displayNodes
    .filter((node) => node.parentId === undefined)
    .map((node) => ({
      ...node.position,
      ...(sizes.get(node.id) ?? CARD_SIZE),
    }));
}

export function cardLabel(node: Node): string {
  return typeof node.data.label === "string" ? node.data.label : node.id;
}

export function frameGroupActions(
  graph: FlatGraph,
  nodeId: string,
): FrameGroupAction[] {
  const node = graph.nodes.find((item) => item.id === nodeId);
  if (!node) return [];
  const frame = framedGroups(graph, graph.nodes).find((item) =>
    item.memberIds.includes(nodeId),
  );
  if (frame) {
    return [
      { frameLabel: frame.label, kind: "pull-out", nodeIds: [nodeId] },
      {
        frameLabel: frame.label,
        kind: "ungroup-all",
        nodeIds: [...frame.memberIds],
      },
    ];
  }
  if (node.data.ungrouped !== true) return [];
  const restored = setUngrouped(
    graph.nodes,
    graph.nodes.map((item) => item.id),
    false,
  );
  const home = framedGroups(graph, restored).find((item) =>
    item.memberIds.includes(nodeId),
  );
  if (!home) return [];
  const reformsAlone = framedGroups(
    graph,
    setUngrouped(graph.nodes, [nodeId], false),
  ).some((item) => item.memberIds.includes(nodeId));
  const pulled = new Set(
    graph.nodes
      .filter((item) => item.data.ungrouped === true)
      .map((item) => item.id),
  );

  return [
    {
      frameLabel: home.label,
      kind: "rejoin",
      nodeIds: reformsAlone
        ? [nodeId]
        : home.memberIds.filter((id) => pulled.has(id)),
    },
  ];
}

export function framedGroups(
  graph: FlatGraph,
  nodes: readonly Node[],
): CanvasFrame[] {
  return framesOf(deriveGroups(nodes, graph.edges, graph.mcpServers));
}

// Keyed by resource ids, so renaming a sandbox or workspace makes no old problem look new.
export function introducedRuntimeRefsProblem(
  before: Pick<FlatGraph, "edges" | "nodes">,
  after: Pick<FlatGraph, "edges" | "nodes">,
): RuntimeRefsProblem | null {
  const keyOf = (problem: RuntimeRefsProblem): string =>
    `${problem.agentId}\n${problem.workspaceId}\n${problem.sandboxId}`;
  const existing = new Set(
    runtimeRefsProblems(before.nodes, before.edges).map(keyOf),
  );

  return (
    runtimeRefsProblems(after.nodes, after.edges).find(
      (problem) => !existing.has(keyOf(problem)),
    ) ?? null
  );
}

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

export function nodeLinkActions(
  nodes: Node[],
  edges: Edge[],
  nodeId: string,
): NodeLinkAction[] {
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return [];
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const linked = edges.flatMap((edge) => {
    const otherId =
      edge.source === nodeId
        ? edge.target
        : edge.target === nodeId
          ? edge.source
          : null;
    const other = otherId === null ? undefined : byId.get(otherId);

    return other ? [{ edge: edge, other: other }] : [];
  });
  const wiringAgents = linked.filter(
    ({ edge, other }) => edgeKind(edge) === "default" && other.type === "agent",
  ).length;

  return linked.flatMap(({ edge, other }): NodeLinkAction[] => {
    const actions: NodeLinkAction[] = [];
    if (
      node.type === "sandbox" &&
      other.type === "agent" &&
      edgeKind(edge) === "default" &&
      !isCodeManagedOwner(other.data.managedBy) &&
      agentSandboxOrder(other, nodes, edges)[0] !== nodeId
    ) {
      const problem = introducedRuntimeRefsProblem(
        { edges: edges, nodes: nodes },
        {
          edges: edges,
          nodes: makeDefaultSandbox(nodes, edges, other.id, nodeId),
        },
      );
      actions.push({
        agentId: other.id,
        agentLabel: wiringAgents > 1 ? cardLabel(other) : null,
        disabledReason: problem
          ? `${problem.workspaceName} is mounted on ${problem.sandboxLabel}`
          : null,
        kind: "make-default",
      });
    }
    actions.push({
      edgeId: edge.id,
      kind: "unlink",
      label:
        edgeKind(edge) !== "subagent"
          ? cardLabel(other)
          : edge.source === nodeId
            ? `calls ${cardLabel(other)}`
            : `called by ${cardLabel(other)}`,
      locked: edge.deletable === false,
      mount: edgeKind(edge) === "mount",
      otherType: other.type,
    });

    return actions;
  });
}

export function reconcileFramePositions(
  previous: FlatGraph,
  next: FlatGraph,
): Node[] {
  const groupsBefore = deriveGroups(
    previous.nodes,
    previous.edges,
    previous.mcpServers,
  );
  const groupsAfter = deriveGroups(next.nodes, next.edges, next.mcpServers);
  const before = framesOf(groupsBefore);
  const after = framesOf(groupsAfter);
  const groupBefore = new Map(groupsBefore.map((group) => [group.id, group]));
  const groupAfter = new Map(groupsAfter.map((group) => [group.id, group]));
  const beforeById = new Map(before.map((frame) => [frame.id, frame]));
  const framedBefore = new Set(before.flatMap((frame) => frame.memberIds));
  const framedAfter = new Set(after.flatMap((frame) => frame.memberIds));
  const previousPositions = positionsById(previous.nodes);
  const nextPositions = positionsById(next.nodes);
  const moves = new Map<string, XYPosition>();
  const occupied: LayoutRect[] = [];
  const place = (
    frame: CanvasFrame,
    origin: XYPosition,
    move: boolean,
  ): void => {
    if (move) {
      for (const [id, position] of frameMemberPositions(origin, frame)) {
        moves.set(id, position);
      }
    }
    occupied.push({ ...origin, ...frameSize(frame) });
  };

  // A frame that searches for its spot goes after every box that already holds one.
  const grown: DeferredFrame[] = [];
  const fresh: DeferredFrame[] = [];
  for (const frame of after) {
    const kept = beforeById.get(frame.id);
    if (!kept) {
      const [card] = groupBefore.get(frame.id)?.memberIds ?? [];
      const cardPosition =
        card === undefined ? undefined : previousPositions.get(card);
      fresh.push({
        desired: cardPosition ?? originOf(frame.memberIds, nextPositions),
        frame: frame,
      });
      continue;
    }
    const origin = originOf(kept.memberIds, previousPositions);
    // Only a taller box can cover a neighbour; a search would snap a shrunk one to grid.
    if (frameSize(frame).height > frameSize(kept).height) {
      grown.push({ desired: origin, frame: frame });
      continue;
    }
    const unchanged = kept.memberIds.join("\n") === frame.memberIds.join("\n");
    place(frame, origin, !unchanged);
  }
  for (const node of next.nodes) {
    if (framedBefore.has(node.id) || framedAfter.has(node.id)) continue;
    occupied.push({ ...node.position, ...CARD_SIZE });
  }
  // A frame that was already drawn has first claim on the space it wants.
  for (const { desired, frame } of [...grown, ...fresh]) {
    place(frame, findFreeBox(desired, frameSize(frame), occupied), true);
  }
  // A frame's last member first, so it keeps the frame's spot over a leaver.
  const leavers = next.nodes
    .filter((node) => framedBefore.has(node.id) && !framedAfter.has(node.id))
    .map((node) => {
      const dissolved = before.find(
        (frame) =>
          frame.memberIds.includes(node.id) &&
          groupAfter.get(frame.id)?.memberIds[0] === node.id,
      );

      return {
        desired: dissolved
          ? originOf(dissolved.memberIds, previousPositions)
          : node.position,
        first: dissolved !== undefined,
        node: node,
      };
    })
    .sort((a, b) => Number(b.first) - Number(a.first));
  for (const { desired, node } of leavers) {
    const position = findFreePosition(desired, occupied);
    moves.set(node.id, position);
    occupied.push({ ...position, ...CARD_SIZE });
  }

  let moved = false;
  const nodes = next.nodes.map((node) => {
    const position = moves.get(node.id);
    if (
      !position ||
      (position.x === node.position.x && position.y === node.position.y)
    ) {
      return node;
    }
    moved = true;

    return { ...node, position: position };
  });

  return moved ? nodes : next.nodes;
}

export function setUngrouped<T extends LayoutNode>(
  nodes: readonly T[],
  ids: readonly string[],
  ungrouped: boolean,
): T[] {
  const targets = new Set(ids);

  return nodes.map((node): T => {
    if (!targets.has(node.id) || (node.data.ungrouped === true) === ungrouped) {
      return node;
    }
    if (ungrouped) {
      return { ...node, data: { ...node.data, ungrouped: true } };
    }
    const { ungrouped: _flag, ...data } = node.data;

    return { ...node, data: data };
  });
}

export function setWorkspaceMount(
  graph: FlatGraph,
  workspaceId: string,
  target: WorkspaceMountTarget,
): { edges: Edge[]; nodes: Node[] } {
  const kept = graph.edges.filter(
    (edge) =>
      edgeKind(edge) !== "mount" ||
      (edge.source !== workspaceId && edge.target !== workspaceId),
  );
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const sandbox =
    target.kind === "sandbox" ? byId.get(target.sandboxId) : undefined;

  return {
    edges:
      sandbox === undefined
        ? kept
        : [
            ...kept,
            connectionEdge(
              {
                source: workspaceId,
                target: sandbox.id,
                ...facingHandles(byId.get(workspaceId), sandbox),
              },
              false,
            ),
          ],
    nodes: graph.nodes.map((node) =>
      node.id === workspaceId
        ? {
            ...node,
            data: { ...node.data, readOnly: target.kind === "readonly" },
          }
        : node,
    ),
  };
}

export function workspaceMountTargets(
  nodes: readonly Node[],
  edges: readonly Edge[],
  workspaceId: string,
): WorkspaceMountTarget[] {
  const workspace = nodes.find((node) => node.id === workspaceId);
  if (
    workspace?.type !== "workspace" ||
    isCodeManagedOwner(workspace.data.managedBy)
  ) {
    return [];
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = workspaceSandboxIds(nodes, edges).get(workspaceId);
  const mounted = new Set(
    state?.kind === "override" ? state.sandboxIds : undefined,
  );
  const wiresAgent = edges.some((edge) => {
    const otherId =
      edge.source === workspaceId
        ? edge.target
        : edge.target === workspaceId
          ? edge.source
          : null;

    return otherId !== null && byId.get(otherId)?.type === "agent";
  });
  const targets: WorkspaceMountTarget[] = [];
  if (wiresAgent) {
    targets.push({ current: state?.kind === "inherited", kind: "default" });
  }
  for (const node of nodes) {
    const config = (node.data as BaseNodeData).config;
    // The config API refuses a workspace mounted on a machine sandbox.
    if (node.type !== "sandbox" || config?.provider === "machine") continue;
    targets.push({
      current: mounted.has(node.id),
      kind: "sandbox",
      label: cardLabel(node),
      sandboxId: node.id,
    });
  }
  targets.push({ current: state?.kind === "readonly", kind: "readonly" });

  return targets;
}

// `findFreePosition` places a card, so grow each box up and left by this box's excess.
function findFreeBox(
  desired: XYPosition,
  size: FrameSize,
  occupied: readonly LayoutRect[],
): XYPosition {
  const extraWidth = size.width - NODE_WIDTH;
  const extraHeight = size.height - NODE_HEIGHT;

  return findFreePosition(
    desired,
    occupied.map((box) => ({
      height: box.height + extraHeight,
      width: box.width + extraWidth,
      x: box.x - extraWidth,
      y: box.y - extraHeight,
    })),
  );
}

function originOf(
  memberIds: readonly string[],
  positions: ReadonlyMap<string, XYPosition>,
): XYPosition {
  return frameOriginOf(memberIds.flatMap((id) => positions.get(id) ?? []));
}

function positionsById(nodes: readonly Node[]): Map<string, XYPosition> {
  return new Map(nodes.map((node) => [node.id, node.position]));
}
