/**
 * Edits on the flat canvas graph that frames care about: where cards go when
 * an edit changes which frame they belong to and what a chip's menu offers.
 * Pure, so each rule is unit-tested here.
 */
import { isCodeManagedOwner } from "@/app/components/canvas/edgeOwnership";
import { deriveGroups, type StageMcpServer } from "@/app/lib/canvasFrameNodes";
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

/** The card box, for the free-spot search. */
const CARD_SIZE: FrameSize = { height: NODE_HEIGHT, width: NODE_WIDTH };

/** A flat graph as one edit sees it, with the server list its frames depend on. */
export type FlatGraph = {
  edges: Edge[];
  /** Undefined while loading; MCP nodes are not framed until then. */
  mcpServers: readonly StageMcpServer[] | undefined;
  nodes: Node[];
};

/**
 * What a right-click offers for the group a node is in, or the one it was
 * pulled out of, and the nodes each entry flags. Every entry writes the same
 * `data.ungrouped` flag: the first two set it, `rejoin` clears it.
 */
export type FrameGroupAction = {
  frameLabel: string;
  kind: "pull-out" | "rejoin" | "ungroup-all";
  nodeIds: string[];
};

/**
 * What a right-click on a chip can do, per agent that wires it directly.
 * `agentLabel` names the agent only when several do, so the entries differ.
 * Make default carries why it is refused, when the config API would refuse it.
 */
export type FrameMemberAction =
  | {
      kind: "make-default";
      agentId: string;
      agentLabel: string | null;
      disabledReason: string | null;
    }
  | { kind: "remove"; agentLabel: string | null; edgeId: string };

/**
 * Whether a service added to a frame would land in it. A fresh node carries
 * the group key its defaults give it, so a cloud sandbox frame and an S3
 * workspace frame take one and the machine, hosted and url frames do not:
 * nothing a new node holds puts it in those.
 */
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

/**
 * The boxes top-level display nodes cover, for the free-spot search. A frame
 * counts at its expanded size even while collapsed, so nothing lands where it
 * opens.
 */
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

/**
 * Group entries for a node's context menu: a member can leave its frame or
 * dissolve it, a node that was pulled out can go back. Rejoining takes the
 * other pulled-out nodes of the same group with it when this node alone would
 * not re-form a frame, so the entry always visibly does something.
 */
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
  const alone = framedGroups(
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
      nodeIds: alone ? [nodeId] : home.memberIds.filter((id) => pulled.has(id)),
    },
  ];
}

/**
 * Chip context menu entries. Make default only where the sandbox is not
 * already first and the agent is not code-managed (code owns its order), and
 * disabled where the new order breaks the runtime rules; remove only where the
 * edge is not locked.
 */
export function frameMemberActions(
  nodes: Node[],
  edges: Edge[],
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
      const problem = introducedRuntimeRefsProblem(
        { edges: edges, nodes: nodes },
        {
          edges: edges,
          nodes: makeDefaultSandbox(nodes, edges, agent.id, memberId),
        },
      );
      actions.push({
        agentId: agent.id,
        agentLabel: labelFor(agent),
        disabledReason: problem
          ? `${problem.workspaceName} is mounted on ${problem.sandboxLabel}`
          : null,
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
 * The first runtime-ref problem `after` has that `before` did not, or null.
 * Used to refuse an edit up front: a problem the graph already had is not
 * this edit's to block. Problems match on resource ids, so renaming a sandbox
 * or a workspace does not make an old problem look new.
 */
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
 * Flat nodes of `next` with positions settled after an edit that may change
 * frame membership. A frame that was already drawn keeps its origin whoever
 * joins or leaves it, and its members take its slots. A frame that grows out
 * of a lone card starts where that card stood, so the card's box becomes the
 * frame's; any other new frame starts where its members stand. Either steps
 * clear of every other box. A frame that shrinks to one member hands its
 * origin to that member's card. Any other card that left all frames steps
 * clear of the frame it sat in. Frames whose members did not change, and
 * cards that stay cards, are not moved. Returns `next.nodes` itself when
 * nothing moves.
 */
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

  for (const frame of after) {
    const kept = beforeById.get(frame.id);
    if (!kept) continue;
    const unchanged = kept.memberIds.join("\n") === frame.memberIds.join("\n");
    place(frame, originOf(kept.memberIds, previousPositions), !unchanged);
  }
  for (const node of next.nodes) {
    if (framedBefore.has(node.id) || framedAfter.has(node.id)) continue;
    occupied.push({ ...node.position, ...CARD_SIZE });
  }
  for (const frame of after) {
    if (beforeById.has(frame.id)) continue;
    const [card] = groupBefore.get(frame.id)?.memberIds ?? [];
    const cardPosition =
      card === undefined ? undefined : previousPositions.get(card);
    place(
      frame,
      findFreeBox(
        cardPosition ?? originOf(frame.memberIds, nextPositions),
        frameSize(frame),
        occupied,
      ),
      true,
    );
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

/**
 * `nodes` with `data.ungrouped` set or cleared on `ids`. The flag is the one
 * stored thing about a group: a node carrying it joins none, so it draws as a
 * card until it is cleared again.
 */
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

/**
 * Nearest grid point where a box of `size` clears every occupied box.
 * `findFreePosition` places a card, so each occupied box grows up and left by
 * how much bigger this box is than a card: a card clears the grown box exactly
 * when this box clears the original.
 */
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

/**
 * The frames `nodes` draw with this graph's edges and server list, for the
 * group entries: the same derivation the canvas draws from.
 */
function framedGroups(graph: FlatGraph, nodes: readonly Node[]): CanvasFrame[] {
  return framesOf(deriveGroups(nodes, graph.edges, graph.mcpServers));
}

/** A frame's origin read from its members' positions in `positions`. */
function originOf(
  memberIds: readonly string[],
  positions: ReadonlyMap<string, XYPosition>,
): XYPosition {
  return frameOriginOf(memberIds.flatMap((id) => positions.get(id) ?? []));
}

function positionsById(nodes: readonly Node[]): Map<string, XYPosition> {
  return new Map(nodes.map((node) => [node.id, node.position]));
}
